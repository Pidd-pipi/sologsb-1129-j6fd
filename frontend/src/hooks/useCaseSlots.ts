import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCaseStore } from '../stores/caseStore';
import type { CaseSlot, TypeCase } from '../types/case';
import type { TypeMatrix } from '../types/matrix';
import { SlotSaveConflictError, type SlotIssue } from '../db/caseCoordinator';
import {
  detectConflicts,
  emptySlots,
  fillRate,
  placeSlot,
  removeSlot,
  swapSlots,
  validateCapacity,
  type RCCell,
  type SlotConflicts,
} from '../utils/layout';

export interface CaseSlotsApi {
  /** 当前编辑中的格位布局（可能尚未保存） */
  slots: CaseSlot[];
  /** 与本机落库版本是否有差异 */
  dirty: boolean;
  saving: boolean;
  conflicts: SlotConflicts;
  capacity: ReturnType<typeof validateCapacity>;
  fillPercent: number;
  emptyCells: RCCell[];
  /** 最近一次保存被拒的冲突清单（草稿保留）；确认后可 dismiss */
  saveError: SlotIssue[] | null;
  dismissSaveError: () => void;
  /** 落位：把一枚可用字模放到指定格位；不可用字模拒绝并返回 false */
  place: (matrix: TypeMatrix, row: number, col: number) => boolean;
  /** 取出格位上的字模 */
  take: (row: number, col: number) => void;
  /** 调换两个格位（目标为空时视为移动） */
  swap: (a: RCCell, b: RCCell) => void;
  clear: () => void;
  replaceAll: (next: CaseSlot[]) => void;
  /** 保存到 IndexedDB：冲突时拒绝并保留草稿，返回是否保存成功 */
  save: () => Promise<boolean>;
  /** 放弃未保存改动，回到落库版本 */
  revert: () => void;
}

/**
 * 字盘格位编辑：落位 / 取出 / 调换，实时给出空格与重复落位提示。
 * 被字盘布局编辑器（`/cases`）与字模详情页（`/matrices/:id`）复用。
 *
 * 保存时以本窗口开始编辑所依据的格位 / updatedAt 为基线，交给 store 在事务内
 * 复核字模现状与其他窗口入库情况；冲突（不可用 / 已清退 / 被别的字盘占用 /
 * 同盘并发改动 / 超容量）只抛出问题清单，不改本地草稿。
 */
export function useCaseSlots(typeCase: TypeCase | undefined): CaseSlotsApi {
  const saveSlots = useCaseStore((s) => s.saveSlots);
  const [slots, setSlots] = useState<CaseSlot[]>(typeCase?.slots ?? []);
  /** 本次编辑所依据的已入库版本（乐观并发基线） */
  const baseRef = useRef<{ updatedAt: string; slots: CaseSlot[] }>({
    updatedAt: typeCase?.updatedAt ?? '',
    slots: typeCase?.slots ?? [],
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<SlotIssue[] | null>(null);

  const version = `${typeCase?.id ?? ''}#${typeCase?.updatedAt ?? ''}`;
  useEffect(() => {
    // 切换字盘或落库版本变化（如其他窗口已保存）时，以最新落库版本为新基线。
    // 本地未保存改动不在这里覆盖：保存时会按基线核对并保留草稿。
    setSlots(typeCase?.slots ?? []);
    baseRef.current = {
      updatedAt: typeCase?.updatedAt ?? '',
      slots: typeCase?.slots ?? [],
    };
    setSaveError(null);
    // 仅在切换字盘或落库版本变化时同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const rows = typeCase?.rows ?? 0;
  const cols = typeCase?.cols ?? 0;

  const dirty = useMemo(
    () => JSON.stringify(slots) !== JSON.stringify(baseRef.current.slots),
    [slots, version],
  );

  const conflicts = useMemo(() => detectConflicts(rows, cols, slots), [rows, cols, slots]);
  const capacity = useMemo(() => validateCapacity(rows, cols, slots), [rows, cols, slots]);
  const fillPercent = useMemo(() => fillRate(slots, rows, cols), [slots, rows, cols]);
  const emptyCells = useMemo(() => emptySlots(rows, cols, slots), [rows, cols, slots]);

  const place = useCallback((matrix: TypeMatrix, row: number, col: number): boolean => {
    if (matrix.availability !== '可用') return false;
    const slot: CaseSlot = {
      row,
      col,
      character: matrix.character,
      matrixId: matrix.id,
      placedAt: new Date().toISOString(),
    };
    setSaveError(null);
    setSlots((cur) => placeSlot(cur, slot));
    return true;
  }, []);

  const take = useCallback((row: number, col: number) => {
    setSaveError(null);
    setSlots((cur) => removeSlot(cur, row, col));
  }, []);

  const swap = useCallback((a: RCCell, b: RCCell) => {
    setSaveError(null);
    setSlots((cur) => swapSlots(cur, a, b));
  }, []);

  const clear = useCallback(() => {
    setSaveError(null);
    setSlots([]);
  }, []);
  const replaceAll = useCallback((next: CaseSlot[]) => {
    setSaveError(null);
    setSlots(next);
  }, []);
  const revert = useCallback(() => {
    setSaveError(null);
    setSlots(typeCase?.slots ?? []);
    baseRef.current = {
      updatedAt: typeCase?.updatedAt ?? '',
      slots: typeCase?.slots ?? [],
    };
  }, [version, typeCase?.slots, typeCase?.updatedAt]);

  const dismissSaveError = useCallback(() => setSaveError(null), []);

  const save = useCallback(async () => {
    if (!typeCase) return false;
    setSaving(true);
    try {
      const saved = await saveSlots(typeCase.id, slots, {
        baseSlots: baseRef.current.slots,
        baseUpdatedAt: baseRef.current.updatedAt,
      });
      // 保存成功：推进基线，草稿即落库版本
      baseRef.current = { updatedAt: saved.updatedAt, slots: saved.slots };
      setSlots(saved.slots);
      setSaveError(null);
      return true;
    } catch (err) {
      if (err instanceof SlotSaveConflictError) {
        // 拒绝保存并保留当前草稿，由界面逐条指出冲突编号
        setSaveError(err.issues);
        return false;
      }
      throw err;
    } finally {
      setSaving(false);
    }
  }, [saveSlots, slots, typeCase]);

  return {
    slots,
    dirty,
    saving,
    conflicts,
    capacity,
    fillPercent,
    emptyCells,
    saveError,
    dismissSaveError,
    place,
    take,
    swap,
    clear,
    replaceAll,
    save,
    revert,
  };
}
