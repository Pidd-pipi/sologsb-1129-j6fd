import { db } from './index';
import type { CaseSlot, TypeCase } from '../types/case';
import { capacityOf } from '../types/case';
import type { TypeMatrix } from '../types/matrix';
import { matrixIdsOf, rcKey } from '../utils/layout';
import { toPlain } from '../utils/format';

/**
 * 字模 / 字盘协同操作。
 *
 * 工坊常开两个窗口同时编辑字模与字盘，落位、取出、可用性变更与清退必须按同一套
 * 现状核对规则处理：
 * - 可用性变为「停用 / 待补刻」、或字模被清退时，同事务清空它在所有字盘里的格位，
 *   格位不允许残留空引用，缺损 / 试印记录不在此处理（仍可查）。
 * - 字盘保存前在同一读写事务内复核字模现状与其他窗口已入库的格位；任何冲突都拒绝
 *   保存，错误中携带编号，由调用方保留本地草稿。
 */

/** 格位的可读编号：行字母 + 列号（A1、B3 …），行、列均按 0 基下标换算 */
export function cellLabel(row: number, col: number): string {
  const letter = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[row] ?? String(row + 1);
  return `${letter}${col + 1}`;
}

export type SlotIssueKind =
  | 'overCapacity'
  | 'outOfRange'
  | 'duplicatePosition'
  | 'matrixUnavailable'
  | 'matrixMissing'
  | 'matrixInOtherCase'
  | 'caseChanged';

export interface SlotIssue {
  kind: SlotIssueKind;
  /** 涉及格位（超出容量时不针对单一格位，可为空数组） */
  cells: string[];
  message: string;
}

export interface PurgeResult {
  /** 受影响的字盘（含字盘编号） */
  affectedCases: Array<{ id: string; code: string; removed: number }>;
  /** 共清退格位数 */
  removedSlots: number;
}

/**
 * 保存布局时的冲突：带结构化问题清单，供界面逐条指出编号并保留草稿。
 */
export class SlotSaveConflictError extends Error {
  readonly issues: SlotIssue[];
  constructor(issues: SlotIssue[]) {
    super(issues.map((i) => i.message).join('；'));
    this.name = 'SlotSaveConflictError';
    this.issues = issues;
  }
}

/**
 * 从全部字盘中清掉一枚字模占用的格位，同步重写 slots 与 matrixId。
 * 不删除缺损、试印记录。
 *
 * 必须在含 cases 表的读写事务内调用（与字模的停用 / 清退一起提交）：
 * Dexie 支持嵌套 / 同库事务合并，外层事务会包裹本函数的全部读写。
 */
export async function purgeMatrixFromCases(
  matrixId: string,
  tx: { table: <T>(name: string) => { toArray: () => Promise<T[]>; update: (key: string, changes: Partial<T>) => Promise<number> } },
): Promise<PurgeResult> {
  const table = tx.table<TypeCase>('cases');
  const allCases = await table.toArray();
  const affected: PurgeResult['affectedCases'] = [];
  let removedSlots = 0;
  for (const c of allCases) {
    if (!c.slots.some((s) => s.matrixId === matrixId)) continue;
    const kept = c.slots.filter((s) => s.matrixId !== matrixId);
    const removed = c.slots.length - kept.length;
    const nextSlots = kept.sort((a, b) => a.row - b.row || a.col - b.col);
    await table.update(c.id, {
      slots: toPlain(nextSlots),
      matrixId: matrixIdsOf(nextSlots),
      updatedAt: new Date().toISOString(),
    });
    affected.push({ id: c.id, code: c.code, removed });
    removedSlots += removed;
  }
  return { affectedCases: affected, removedSlots };
}

export interface SaveSlotsOptions {
  /** 本窗口开始编辑时所依据的已入库格位；用于核对其他窗口是否已改动同一字盘 */
  baseSlots: CaseSlot[];
  /** 本窗口开始编辑时所依据的 updatedAt；为空则不做版本核对 */
  baseUpdatedAt?: string;
}

export interface SavedCaseResult {
  typeCase: TypeCase;
}

/**
 * 保存字盘格位：同一读写事务内复核现状后写入。
 *
 * 复核项（任一不通过即整体拒绝，调用方据此保留草稿）：
 * 1. 格数不超过 rows × cols，格位不越界、同一格位不重复；
 * 2. 引用的每枚字模仍存在且为「可用」（指出字模编号与格位）；
 * 3. 字模未被其他窗口落到别的字盘（指出字模与对方字盘编号）；
 * 4. 同一字盘未被其他窗口改过（指出对方已入库版本涉及的格位）。
 */
export async function saveCaseSlotsChecked(
  caseId: string,
  draftSlots: CaseSlot[],
  options: SaveSlotsOptions,
): Promise<SavedCaseResult> {
  const slots = toPlain(draftSlots).sort((a, b) => a.row - b.row || a.col - b.col);
  const issues: SlotIssue[] = [];

  const result = await db.transaction('rw', db.cases, db.matrices, db.defects, async (tx) => {
    issues.length = 0;
    const live = await db.cases.get(caseId);
    if (!live) throw new Error('未找到字盘，可能已被其他窗口删除');

    // 1. 容量 / 边界 / 同格位重复
    const capacity = capacityOf(live.rows, live.cols);
    if (slots.length > capacity) {
      issues.push({
        kind: 'overCapacity',
        cells: [],
        message: `落位 ${slots.length} 格已超出字盘容量 ${capacity} 格，请先取出多余字模`,
      });
    }
    const outCells: string[] = [];
    const posCount = new Map<string, number>();
    for (const s of slots) {
      posCount.set(rcKey(s.row, s.col), (posCount.get(rcKey(s.row, s.col)) ?? 0) + 1);
      if (s.row < 0 || s.col < 0 || s.row >= live.rows || s.col >= live.cols) {
        outCells.push(cellLabel(s.row, s.col));
      }
    }
    if (outCells.length) {
      issues.push({
        kind: 'outOfRange',
        cells: outCells,
        message: `格位 ${outCells.join('、')} 超出字盘 ${live.rows} 行 × ${live.cols} 列边界`,
      });
    }
    const dupCells = Array.from(posCount.entries())
      .filter(([, n]) => n > 1)
      .map(([k]) => {
        const [r, c] = k.split('-');
        return cellLabel(Number(r), Number(c));
      });
    if (dupCells.length) {
      issues.push({
        kind: 'duplicatePosition',
        cells: dupCells,
        message: `同一格位出现多条落位：${dupCells.join('、')}`,
      });
    }

    // 2. 字模现状：仍存在且可用
    const ids = matrixIdsOf(slots);
    const matrices = await db.matrices.bulkGet(ids);
    const matrixMap = new Map<string, TypeMatrix | undefined>();
    ids.forEach((id, i) => matrixMap.set(id, matrices[i] ?? undefined));

    const missingById = new Map<string, string[]>();
    const unavailableById = new Map<string, string[]>();
    for (const s of slots) {
      const m = matrixMap.get(s.matrixId);
      const label = cellLabel(s.row, s.col);
      if (!m) {
        const arr = missingById.get(s.matrixId) ?? [];
        arr.push(label);
        missingById.set(s.matrixId, arr);
      } else if (m.availability !== '可用') {
        const arr = unavailableById.get(s.matrixId) ?? [];
        arr.push(label);
        unavailableById.set(s.matrixId, arr);
      }
    }
    // 清退字模的编号冗余在缺损记录里，尽量补出人类可读编号
    const defectRows = missingById.size
      ? await tx
          .table<{ matrixId: string; matrixCode: string }>('defects')
          .toArray()
      : [];
    const codeOfMissing = (id: string) =>
      defectRows.find((d) => d.matrixId === id)?.matrixCode || id;
    for (const [id, cells] of missingById) {
      issues.push({
        kind: 'matrixMissing',
        cells,
        message: `字模 ${codeOfMissing(id)} 已被清退，仍出现在格位 ${cells.join('、')}，请取出该字模`,
      });
    }
    for (const [id, cells] of unavailableById) {
      const m = matrixMap.get(id);
      issues.push({
        kind: 'matrixUnavailable',
        cells,
        message: `字模 ${m?.code ?? id} 现为「${m?.availability ?? '不可用'}」，不能占格（格位 ${cells.join('、')}），请改用可用字模`,
      });
    }

    // 3. 其他窗口已把同一字模落到别的字盘
    const otherCases = (await db.cases.toArray()).filter((c) => c.id !== caseId);
    const occupiedElsewhere = new Map<string, { code: string; slots: CaseSlot[] }>();
    for (const c of otherCases) {
      for (const s of c.slots) {
        if (!matrixMap.has(s.matrixId)) continue;
        const entry = occupiedElsewhere.get(s.matrixId) ?? { code: c.code, slots: [] };
        entry.slots.push(s);
        occupiedElsewhere.set(s.matrixId, entry);
      }
    }
    for (const [id, hit] of occupiedElsewhere) {
      const m = matrixMap.get(id);
      issues.push({
        kind: 'matrixInOtherCase',
        cells: hit.slots.map((s) => cellLabel(s.row, s.col)),
        message: `字模 ${m?.code ?? id} 已在其他窗口入库到字盘 ${hit.code} 的格位 ${hit.slots
          .map((s) => cellLabel(s.row, s.col))
          .join('、')}，一枚字模不能同时占两个格位`,
      });
    }

    // 4. 同一字盘被其他窗口改动（乐观并发核对）
    if (options.baseUpdatedAt && live.updatedAt !== options.baseUpdatedAt) {
      const changed = diffChangedCells(options.baseSlots, live.slots);
      const where = changed.length ? `（对方改动涉及格位 ${changed.join('、')}）` : '';
      issues.push({
        kind: 'caseChanged',
        cells: changed,
        message: `字盘 ${live.code} 已被其他窗口改动并保存${where}，请撤回到最新版本后合并改动再保存`,
      });
    }

    if (issues.length) throw new SlotSaveConflictError(issues);

    const next: Partial<TypeCase> = {
      slots: toPlain(slots),
      matrixId: matrixIdsOf(slots),
      updatedAt: new Date().toISOString(),
    };
    await db.cases.update(caseId, next);
    return { typeCase: { ...live, ...next, slots } as TypeCase };
  });

  return result;
}

/**
 * 对比两个版本的格位，返回有差异的格位可读编号（新增、取出、换字都算），最多列 8 个。
 */
export function diffChangedCells(base: CaseSlot[], live: CaseSlot[]): string[] {
  const baseMap = new Map(base.map((s) => [rcKey(s.row, s.col), s]));
  const liveMap = new Map(live.map((s) => [rcKey(s.row, s.col), s]));
  const keys = new Set([...baseMap.keys(), ...liveMap.keys()]);
  const changed: string[] = [];
  for (const key of keys) {
    const a = baseMap.get(key);
    const b = liveMap.get(key);
    if (a?.matrixId === b?.matrixId) continue;
    const [r, c] = key.split('-');
    changed.push(cellLabel(Number(r), Number(c)));
  }
  changed.sort((x, y) => x.localeCompare(y, 'zh-Hans-CN'));
  return changed.slice(0, 8);
}
