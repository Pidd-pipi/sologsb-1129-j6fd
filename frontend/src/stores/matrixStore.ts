import { create } from 'zustand';
import { db, ensureSeed } from '../db';
import { purgeMatrixFromCases, type PurgeResult } from '../db/caseCoordinator';
import { useCaseStore } from './caseStore';
import type { DefectInput, DefectLog } from '../types/defect';
import { shouldDisableMatrix } from '../types/defect';
import type { MatrixInput, MatrixAvailability, TypeMatrix } from '../types/matrix';
import { ptOfSize } from '../types/matrix';
import type { ProofInput, ProofRecord } from '../types/proof';
import { makeId, toPlain, todayStr } from '../utils/format';

/** 字模停用 / 清退后同步字盘格位的结果，供界面提示清退了哪些格位 */
export interface MatrixMutationResult {
  defect?: DefectLog;
  purge?: PurgeResult;
}

interface MatrixState {
  matrices: TypeMatrix[];
  defects: DefectLog[];
  proofs: ProofRecord[];
  loaded: boolean;
  loading: boolean;
  error: string;
  load: () => Promise<void>;
  createMatrix: (input: MatrixInput) => Promise<TypeMatrix>;
  updateMatrix: (id: string, patch: Partial<TypeMatrix>) => Promise<MatrixMutationResult>;
  removeMatrix: (id: string) => Promise<PurgeResult>;
  addDefect: (input: DefectInput) => Promise<MatrixMutationResult>;
  repairMatrix: (matrixId: string, operator: string) => Promise<MatrixMutationResult>;
  addProof: (input: ProofInput) => Promise<ProofRecord>;
}

const byUpdatedDesc = (a: TypeMatrix, b: TypeMatrix) => (a.updatedAt < b.updatedAt ? 1 : -1);

/** 把字模可用性变化 / 清退导致的字盘格位变更同步到字盘内存档案 */
function syncCasesAfterPurge(purge: PurgeResult | undefined) {
  if (!purge || purge.affectedCases.length === 0) return;
  // 字盘已在同一事务内落库，直接从库重读以保证 slots / matrixId 完全一致
  void useCaseStore.getState().load();
}

export const useMatrixStore = create<MatrixState>((set, get) => ({
  matrices: [],
  defects: [],
  proofs: [],
  loaded: false,
  loading: false,
  error: '',

  /** 首次进入时写入示例档案并读回全部数据 */
  load: async () => {
    set({ loading: true, error: '' });
    try {
      await ensureSeed();
      const [matrices, defects, proofs] = await Promise.all([
        db.matrices.toArray(),
        db.defects.toArray(),
        db.proofs.toArray(),
      ]);
      set({
        matrices: matrices.sort(byUpdatedDesc),
        defects,
        proofs,
        loaded: true,
        loading: false,
      });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : '本地档案读取失败' });
    }
  },

  createMatrix: async (input) => {
    const now = new Date().toISOString();
    const row: TypeMatrix = toPlain({
      id: makeId('mtx'),
      code: input.code.trim(),
      character: input.character.trim(),
      font: input.font,
      sizeName: input.sizeName,
      sizePt: ptOfSize(input.sizeName),
      material: input.material,
      faceWidthMm: Number(input.faceWidthMm),
      bodyHeightMm: Number(input.bodyHeightMm),
      madeYear: Number(input.madeYear),
      engraver: input.engraver.trim(),
      availability: '可用' as const,
      note: (input.note ?? '').trim(),
      createdAt: now,
      updatedAt: now,
    });
    await db.matrices.add(row);
    set((s) => ({ matrices: [row, ...s.matrices] }));
    return row;
  },

  /**
   * 更新字模。可用性变为「停用 / 待补刻」时，与清空该字模在全部字盘里的格位
   * 在同一事务内提交（格位不残留不可用字模、不留空引用）。
   */
  updateMatrix: async (id, patch) => {
    const plain = toPlain(patch);
    const now = new Date().toISOString();
    const willDisable =
      plain.availability !== undefined && plain.availability !== '可用';
    if (plain.sizeName) plain.sizePt = ptOfSize(plain.sizeName);

    let purge: PurgeResult | undefined;
    await db.transaction('rw', db.matrices, db.cases, async (tx) => {
      const exists = await db.matrices.get(id);
      if (!exists) throw new Error('未找到对应字模，可能已被其他窗口清退');
      const next: Partial<TypeMatrix> = { ...plain, updatedAt: now };
      await db.matrices.update(id, next);
      if (willDisable) purge = await purgeMatrixFromCases(id, tx);
    });

    set((s) => ({
      matrices: s.matrices
        .map((m) => (m.id === id ? { ...m, ...plain, updatedAt: now } : m))
        .sort(byUpdatedDesc),
    }));
    syncCasesAfterPurge(purge);
    return { purge };
  },

  /**
   * 清退字模：删除字模本体，并同步清掉它在全部字盘里的格位（不留空引用）。
   * 缺损、试印记录保留，仍可在缺损看板与试印台账中按编号查阅。
   */
  removeMatrix: async (id) => {
    let purge: PurgeResult = { affectedCases: [], removedSlots: 0 };
    await db.transaction('rw', db.matrices, db.cases, db.defects, db.proofs, async (tx) => {
      const exists = await db.matrices.get(id);
      if (!exists) throw new Error('未找到对应字模，可能已被其他窗口清退');
      purge = await purgeMatrixFromCases(id, tx);
      await db.matrices.delete(id);
      // 注意：不删除 defects / proofs，缺损与试印档案保留可查
    });
    set((s) => ({
      matrices: s.matrices.filter((m) => m.id !== id),
    }));
    syncCasesAfterPurge(purge);
    return purge;
  },

  /**
   * 登记缺损：写缺损记录；结论为「停用 / 待补刻」时，与字模改状态、清空其全部
   * 占格在同一事务内提交，避免另一窗口仍把不可用字模存入字盘。
   */
  addDefect: async (input) => {
    let row: DefectLog | undefined;
    let purge: PurgeResult | undefined;
    await db.transaction('rw', db.matrices, db.cases, db.defects, async (tx) => {
      const matrix = await db.matrices.get(input.matrixId);
      if (!matrix) throw new Error('未找到对应字模，无法登记缺损');
      row = toPlain({
        id: makeId('dft'),
        matrixId: input.matrixId,
        character: matrix.character,
        matrixCode: matrix.code,
        defectType: input.defectType,
        severity: input.severity,
        foundDate: input.foundDate || todayStr(),
        handling: input.handling.trim(),
        availability: input.availability,
        operator: input.operator.trim(),
        note: (input.note ?? '').trim(),
        createdAt: new Date().toISOString(),
      });
      await db.defects.add(row);
      if (shouldDisableMatrix(input.availability)) {
        await db.matrices.update(input.matrixId, {
          availability: input.availability as MatrixAvailability,
          updatedAt: new Date().toISOString(),
        });
        purge = await purgeMatrixFromCases(input.matrixId, tx);
      }
    });

    const saved = row as DefectLog;
    set((s) => ({
      defects: [saved, ...s.defects],
      matrices: shouldDisableMatrix(input.availability)
        ? s.matrices
            .map((m) =>
              m.id === input.matrixId
                ? { ...m, availability: input.availability, updatedAt: saved.createdAt }
                : m,
            )
            .sort(byUpdatedDesc)
        : s.matrices,
    }));
    syncCasesAfterPurge(purge);
    return { defect: saved, purge };
  },

  /** 补刻完成：恢复可用，并留下一条收尾记录（不动字盘格位，需重新落位） */
  repairMatrix: async (matrixId, operator) => {
    let row: DefectLog | undefined;
    await db.transaction('rw', db.matrices, db.defects, async () => {
      const matrix = await db.matrices.get(matrixId);
      if (!matrix) throw new Error('未找到对应字模，无法补刻');
      const history = await db.defects.where('matrixId').equals(matrixId).toArray();
      const last = history.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
      const now = new Date().toISOString();
      row = toPlain({
        id: makeId('dft'),
        matrixId,
        character: matrix.character,
        matrixCode: matrix.code,
        defectType: last?.defectType ?? '磨损',
        severity: last?.severity ?? '轻',
        foundDate: todayStr(),
        handling: `补刻完成，字面复测合格（原处理：${last?.handling ?? '未记录'}）`,
        availability: '可用' as const,
        operator: operator.trim() || '补刻工',
        note: '补刻收尾记录',
        createdAt: now,
      });
      await db.defects.add(row);
      await db.matrices.update(matrixId, { availability: '可用', updatedAt: now });
    });

    const saved = row as DefectLog;
    set((s) => ({
      defects: [saved, ...s.defects],
      matrices: s.matrices
        .map((m) =>
          m.id === matrixId ? { ...m, availability: '可用' as const, updatedAt: saved.createdAt } : m,
        )
        .sort(byUpdatedDesc),
    }));
    return { defect: saved };
  },

  addProof: async (input) => {
    const matrix = input.matrixId ? get().matrices.find((m) => m.id === input.matrixId) : undefined;
    const row: ProofRecord = toPlain({
      id: makeId('pfr'),
      targetKind: input.targetKind,
      targetRef: input.targetRef.trim(),
      matrixId: input.matrixId,
      pressureKg: Number(input.pressureKg),
      ink: input.ink.trim(),
      impressions: Number(input.impressions),
      sampleNo: input.sampleNo.trim(),
      clarity: input.clarity,
      proofDate: input.proofDate || todayStr(),
      note: (input.note ?? '').trim(),
      createdAt: new Date().toISOString(),
    });
    if (matrix && input.targetKind === '字符' && !row.targetRef) row.targetRef = matrix.character;
    await db.proofs.add(row);
    set((s) => ({ proofs: [row, ...s.proofs] }));
    return row;
  },
}));

/** 单条字模（组件内使用，避免整表订阅） */
export function selectMatrix(id: string) {
  return (s: MatrixState) => s.matrices.find((m) => m.id === id);
}
