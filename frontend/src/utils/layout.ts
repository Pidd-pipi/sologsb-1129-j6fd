import type { CaseSlot } from '../types/case';
import { capacityOf } from '../types/case';
import type { TypeMatrix } from '../types/matrix';

/** 行列号与格位索引互算、字盘容量校验与冲突检测 */

export interface RCCell {
  row: number;
  col: number;
}

/** 格位键：`行-列`（0 基） */
export function rcKey(row: number, col: number): string {
  return `${row}-${col}`;
}

/** 解析格位键，非法返回 null */
export function parseRcKey(key: string): RCCell | null {
  const [r, c] = key.split('-');
  const row = Number(r);
  const col = Number(c);
  if (!Number.isInteger(row) || !Number.isInteger(col)) return null;
  return { row, col };
}

/** 二维行列 → 一维格位索引（0 基） */
export function slotIndex(row: number, col: number, cols: number): number {
  return row * cols + col;
}

/** 一维格位索引 → 行列 */
export function indexToRC(index: number, cols: number): RCCell {
  return { row: Math.floor(index / cols), col: index % cols };
}

/** 是否落在字盘边界内 */
export function isWithinBounds(row: number, col: number, rows: number, cols: number): boolean {
  return row >= 0 && col >= 0 && row < rows && col < cols;
}

/** 全部格位（按行优先展开） */
export function allPositions(rows: number, cols: number): RCCell[] {
  const out: RCCell[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) out.push({ row: r, col: c });
  }
  return out;
}

/** 已占用格位键集合 */
export function occupiedKeys(slots: CaseSlot[]): Set<string> {
  return new Set(slots.map((s) => rcKey(s.row, s.col)));
}

/** 空格位清单 */
export function emptySlots(rows: number, cols: number, slots: CaseSlot[]): RCCell[] {
  const used = occupiedKeys(slots);
  return allPositions(rows, cols).filter((p) => !used.has(rcKey(p.row, p.col)));
}

/** 取指定格位的落位 */
export function slotAt(slots: CaseSlot[], row: number, col: number): CaseSlot | undefined {
  return slots.find((s) => s.row === row && s.col === col);
}

export interface DuplicateGroup {
  character: string;
  count: number;
  keys: string[];
}

export interface SlotConflicts {
  /** 同一字符重复落位的分组 */
  duplicateCharacters: DuplicateGroup[];
  /** 同一格位出现多条落位记录 */
  duplicatePositions: string[];
  /** 越界格位 */
  outOfRange: string[];
  hasConflict: boolean;
}

/** 冲突检测：重复落位、同格位重复、越界 */
export function detectConflicts(rows: number, cols: number, slots: CaseSlot[]): SlotConflicts {
  const byChar = new Map<string, string[]>();
  const byKey = new Map<string, number>();
  const outOfRange: string[] = [];
  for (const s of slots) {
    const key = rcKey(s.row, s.col);
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
    if (!isWithinBounds(s.row, s.col, rows, cols)) outOfRange.push(key);
    const arr = byChar.get(s.character) ?? [];
    arr.push(key);
    byChar.set(s.character, arr);
  }
  const duplicateCharacters: DuplicateGroup[] = [];
  byChar.forEach((keys, character) => {
    if (keys.length > 1) duplicateCharacters.push({ character, count: keys.length, keys });
  });
  const duplicatePositions = Array.from(byKey.entries())
    .filter(([, n]) => n > 1)
    .map(([k]) => k);
  return {
    duplicateCharacters,
    duplicatePositions,
    outOfRange,
    hasConflict: duplicateCharacters.length > 0 || duplicatePositions.length > 0 || outOfRange.length > 0,
  };
}

/** 容量校验：行 / 列合法性与可用格位数 */
export function validateCapacity(
  rows: number,
  cols: number,
  slots: CaseSlot[],
): { capacity: number; filled: number; empty: number; overCapacity: boolean; message: string } {
  const capacity = capacityOf(rows, cols);
  const filled = slots.length;
  const empty = Math.max(0, capacity - filled);
  const overCapacity = filled > capacity;
  const message = overCapacity
    ? `落位 ${filled} 格已超出字盘容量 ${capacity} 格，请先取出多余字模`
    : `已落位 ${filled} / ${capacity} 格，空余 ${empty} 格`;
  return { capacity, filled, empty, overCapacity, message };
}

/** 落位（同格位覆盖）；返回新的 slots 数组，不修改入参 */
export function placeSlot(slots: CaseSlot[], slot: CaseSlot): CaseSlot[] {
  const rest = slots.filter((s) => !(s.row === slot.row && s.col === slot.col));
  return [...rest, slot].sort((a, b) => a.row - b.row || a.col - b.col);
}

/** 取出格位上的字模 */
export function removeSlot(slots: CaseSlot[], row: number, col: number): CaseSlot[] {
  return slots.filter((s) => !(s.row === row && s.col === col));
}

/** 调换两格内容：目标为空则视为移动 */
export function swapSlots(slots: CaseSlot[], a: RCCell, b: RCCell): CaseSlot[] {
  const sa = slotAt(slots, a.row, a.col);
  const sb = slotAt(slots, b.row, b.col);
  if (!sa && !sb) return slots;
  let next = removeSlot(removeSlot(slots, a.row, a.col), b.row, b.col);
  if (sa) next = placeSlot(next, { ...sa, row: b.row, col: b.col });
  if (sb) next = placeSlot(next, { ...sb, row: a.row, col: a.col });
  return next;
}

/** 已落位字模 id 列表（去重，用于写入字盘的多值索引） */
export function matrixIdsOf(slots: CaseSlot[]): string[] {
  return Array.from(new Set(slots.map((s) => s.matrixId).filter(Boolean)));
}

/** 落位率百分比（一位小数） */
export function fillRate(slots: CaseSlot[], rows: number, cols: number): number {
  const capacity = capacityOf(rows, cols);
  if (!capacity) return 0;
  return Math.round((slots.length / capacity) * 1000) / 10;
}

/** 找出某字模在字盘中的格位 */
export function findSlotsByMatrix(slots: CaseSlot[], matrixId: string): CaseSlot[] {
  return slots.filter((s) => s.matrixId === matrixId);
}

/** 从格位列表中移除指定字模的所有落位（字模停用 / 清退时同步清格位用） */
export function removeSlotsByMatrix(slots: CaseSlot[], matrixId: string): CaseSlot[] {
  return slots.filter((s) => s.matrixId !== matrixId);
}

/** 保存前核对发现的冲突：字模现状或其他字盘入库格位不一致 */
export interface SlotSaveConflict {
  /** missing=字模已被清退；unavailable=字模被停用/待补刻；duplicate=已落在其他字盘；duplicateInCase=本盘内重复落位 */
  kind: 'missing' | 'unavailable' | 'duplicate' | 'duplicateInCase';
  matrixId: string;
  /** 字模编号（优先用落位时冗余保存的编号，其次回退 matrixId） */
  matrixCode: string;
  character: string;
  /** 可读的冲突说明，包含编号与所在格位 / 字盘 */
  message: string;
}

/**
 * 保存格位前的核对：以最新读取的字模档案与其他字盘格位为准，
 * 检查草稿中的每一枚字模是否仍然存在、仍然可用、且没有被其他字盘占用。
 * 返回冲突列表；空数组表示可以保存。
 */
export function validateSlotsForSave(
  slots: CaseSlot[],
  matrices: TypeMatrix[],
  otherCases: Array<{ code: string; slots: CaseSlot[] }>,
): SlotSaveConflict[] {
  const conflicts: SlotSaveConflict[] = [];
  const matrixById = new Map(matrices.map((m) => [m.id, m]));
  // 其他字盘已占用的字模 id → 字盘编号
  const placedInOther = new Map<string, string>();
  for (const c of otherCases) {
    for (const s of c.slots) {
      if (!placedInOther.has(s.matrixId)) placedInOther.set(s.matrixId, c.code);
    }
  }
  const seenInThis = new Set<string>();
  for (const s of slots) {
    const cell = rcKey(s.row, s.col);
    const fallbackCode = s.matrixCode || s.matrixId;
    const m = matrixById.get(s.matrixId);
    if (!m) {
      conflicts.push({
        kind: 'missing',
        matrixId: s.matrixId,
        matrixCode: fallbackCode,
        character: s.character,
        message: `格位 ${cell} 的字模 ${fallbackCode}（${s.character}）已被清退，档案中不存在该字模`,
      });
      continue;
    }
    if (m.availability !== '可用') {
      conflicts.push({
        kind: 'unavailable',
        matrixId: s.matrixId,
        matrixCode: m.code,
        character: m.character,
        message: `格位 ${cell} 的字模 ${m.code}（${m.character}）当前为「${m.availability}」，不可落位`,
      });
      continue;
    }
    const otherCode = placedInOther.get(s.matrixId);
    if (otherCode) {
      conflicts.push({
        kind: 'duplicate',
        matrixId: s.matrixId,
        matrixCode: m.code,
        character: m.character,
        message: `字模 ${m.code}（${m.character}）已落位于字盘 ${otherCode}，一枚字模不能同时占两个格位`,
      });
      continue;
    }
    if (seenInThis.has(s.matrixId)) {
      conflicts.push({
        kind: 'duplicateInCase',
        matrixId: s.matrixId,
        matrixCode: m.code,
        character: m.character,
        message: `字模 ${m.code}（${m.character}）在本盘格位中重复出现`,
      });
    }
    seenInThis.add(s.matrixId);
  }
  return conflicts;
}
