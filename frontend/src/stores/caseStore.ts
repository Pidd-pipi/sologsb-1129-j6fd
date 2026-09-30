import { create } from 'zustand';
import { db, ensureSeed } from '../db';
import type { CaseInput, CaseSlot, TypeCase } from '../types/case';
import { capacityOf } from '../types/case';
import { makeId, toPlain } from '../utils/format';
import { matrixIdsOf, removeSlotsByMatrix, validateCapacity, validateSlotsForSave } from '../utils/layout';

interface CaseState {
  cases: TypeCase[];
  loaded: boolean;
  loading: boolean;
  error: string;
  load: () => Promise<void>;
  createCase: (input: CaseInput) => Promise<TypeCase>;
  updateCase: (id: string, patch: Partial<TypeCase>) => Promise<void>;
  saveSlots: (id: string, slots: CaseSlot[]) => Promise<void>;
  /** 字模停用 / 清退时，同步清除它在所有字盘里的格位 */
  clearMatrixFromCases: (matrixId: string) => Promise<void>;
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

  /** 保存格位布局：同时刷新 matrixId 多值索引，便于按字模反查字盘 */
  saveSlots: async (id, slots) => {
    // 保存前核对：从 IndexedDB 重新读取字模现状、本盘容量与其他字盘的入库格位。
    // 另一个窗口可能已把字模停用 / 待补刻 / 清退，或已调整本盘行列、把同一字模落到别的字盘。
    const [matrices, allCases] = await Promise.all([db.matrices.toArray(), db.cases.toArray()]);
    const persisted = allCases.find((c) => c.id === id);
    if (!persisted) throw new Error('未找到字盘');
    const capacityCheck = validateCapacity(persisted.rows, persisted.cols, slots);
    if (capacityCheck.overCapacity) throw new Error(capacityCheck.message);

    const otherCases = allCases
      .filter((c) => c.id !== id)
      .map((c) => ({ code: c.code, slots: c.slots ?? [] }));
    const conflicts = validateSlotsForSave(slots, matrices, otherCases);
    if (conflicts.length > 0) {
      const detail = conflicts.map((c) => c.message).join('；');
      throw new Error(`保存被拒绝：${detail}。草稿已保留，请核对后再保存。`);
    }

    const plainSlots = toPlain(slots);
    const next: Partial<TypeCase> = {
      slots: plainSlots,
      matrixId: matrixIdsOf(plainSlots),
      updatedAt: new Date().toISOString(),
    };
    await db.cases.update(id, next);
    set((s) => ({ cases: s.cases.map((c) => (c.id === id ? { ...c, ...next } : c)) }));
  },

  /** 字模停用 / 清退时，同步清除它在所有字盘里的格位，并刷新 matrixId 索引 */
  clearMatrixFromCases: async (matrixId) => {
    const allCases = await db.cases.toArray();
    const touched: TypeCase[] = [];
    for (const c of allCases) {
      const filtered = removeSlotsByMatrix(c.slots ?? [], matrixId);
      if (filtered.length === (c.slots ?? []).length) continue;
      const next: Partial<TypeCase> = {
        slots: filtered,
        matrixId: matrixIdsOf(filtered),
        updatedAt: new Date().toISOString(),
      };
      await db.cases.update(c.id, next);
      touched.push({ ...c, ...next } as TypeCase);
    }
    if (touched.length > 0) {
      set((s) => ({
        cases: s.cases.map((c) => {
          const t = touched.find((x) => x.id === c.id);
          return t ? t : c;
        }),
      }));
    }
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
