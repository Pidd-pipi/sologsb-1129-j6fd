import { create } from 'zustand';
import { db, ensureSeed } from '../db';
import { saveCaseSlotsChecked, type SaveSlotsOptions } from '../db/caseCoordinator';
import type { CaseInput, CaseSlot, TypeCase } from '../types/case';
import { capacityOf } from '../types/case';
import { makeId, toPlain } from '../utils/format';
import { validateCapacity } from '../utils/layout';

interface CaseState {
  cases: TypeCase[];
  loaded: boolean;
  loading: boolean;
  error: string;
  load: () => Promise<void>;
  createCase: (input: CaseInput) => Promise<TypeCase>;
  updateCase: (id: string, patch: Partial<TypeCase>) => Promise<void>;
  saveSlots: (id: string, slots: CaseSlot[], options?: SaveSlotsOptions) => Promise<TypeCase>;
  removeCase: (id: string) => Promise<void>;
}

export const useCaseStore = create<CaseState>((set, get) => ({
  cases: [],
  loaded: false,
  loading: false,
  error: '',

  load: async () => {
    set({ loading: true, error: '' });
    try {
      await ensureSeed();
      const cases = await db.cases.toArray();
      set({ cases: cases.sort((a, b) => (a.code < b.code ? -1 : 1)), loaded: true, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : '字盘档案读取失败' });
    }
  },

  createCase: async (input) => {
    const now = new Date().toISOString();
    const rows = Number(input.rows);
    const cols = Number(input.cols);
    const row: TypeCase = toPlain({
      id: makeId('case'),
      code: input.code.trim(),
      kind: input.kind,
      rows,
      cols,
      slots: [] as CaseSlot[],
      workStation: input.workStation.trim(),
      matrixId: [] as string[],
      createdAt: now,
      updatedAt: now,
    });
    if (capacityOf(rows, cols) <= 0) throw new Error('字盘容量不合法，请检查行列数');
    await db.cases.add(row);
    set((s) => ({ cases: [...s.cases, row].sort((a, b) => (a.code < b.code ? -1 : 1)) }));
    return row;
  },

  updateCase: async (id, patch) => {
    const plain = toPlain(patch);
    const next: Partial<TypeCase> = { ...plain, updatedAt: new Date().toISOString() };
    if (plain.rows || plain.cols) {
      const current = get().cases.find((c) => c.id === id);
      const rows = plain.rows ?? current?.rows ?? 0;
      const cols = plain.cols ?? current?.cols ?? 0;
      const slots = plain.slots ?? current?.slots ?? [];
      const check = validateCapacity(rows, cols, slots);
      if (check.overCapacity) throw new Error(check.message);
    }
    await db.cases.update(id, next);
    set((s) => ({ cases: s.cases.map((c) => (c.id === id ? { ...c, ...next } : c)) }));
  },

  /**
   * 保存格位布局：保存前在同一事务内复核字模现状与其他窗口已入库格位
   * （可用性、被清退、被别的字盘占用、同一字盘被并发改动、容量 / 越界）。
   * 冲突时抛出 SlotSaveConflictError，不改库；调用方据此保留草稿。
   * 成功后刷新 slots 与 matrixId 多值索引，返回最新字盘。
   */
  saveSlots: async (id, slots, options) => {
    const current = get().cases.find((c) => c.id === id);
    if (!current) throw new Error('未找到字盘');
    const saved = await saveCaseSlotsChecked(id, slots, {
      baseSlots: options?.baseSlots ?? current.slots,
      baseUpdatedAt: options?.baseUpdatedAt ?? current.updatedAt,
    });
    set((s) => ({ cases: s.cases.map((c) => (c.id === id ? saved.typeCase : c)) }));
    return saved.typeCase;
  },

  removeCase: async (id) => {
    await db.cases.delete(id);
    set((s) => ({ cases: s.cases.filter((c) => c.id !== id) }));
  },
}));

/** 找出存放指定字模的字盘与格位 */
export function findCaseHolding(cases: TypeCase[], matrixId: string): Array<{ typeCase: TypeCase; slots: CaseSlot[] }> {
  const out: Array<{ typeCase: TypeCase; slots: CaseSlot[] }> = [];
  for (const c of cases) {
    const slots = c.slots.filter((s) => s.matrixId === matrixId);
    if (slots.length) out.push({ typeCase: c, slots });
  }
  return out;
}
