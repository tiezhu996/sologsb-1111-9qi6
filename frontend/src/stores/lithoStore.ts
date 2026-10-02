import { create } from 'zustand';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import type { Alteration, LithoLog, Lithology, Mineralization, RangeConflict } from '../types/litho-log';
import { findConflicts } from '../utils/recovery';

export interface LithoInput {
  holeId: string;
  fromDepth: number;
  toDepth: number;
  lithology: Lithology;
  color: string;
  alteration: Alteration;
  mineralization: Mineralization;
  rqd: number;
  sampleNo: string;
  logger: string;
  remark?: string;
}

interface LithoState {
  lithos: LithoLog[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** 编录区间冲突校验：返回与已编录区间重叠的冲突项（空数组表示无冲突） */
  checkConflicts: (input: Pick<LithoInput, 'holeId' | 'fromDepth' | 'toDepth'>, ignoreId?: string) => RangeConflict[];
  addLitho: (input: LithoInput) => Promise<{ log?: LithoLog; conflicts: RangeConflict[] }>;
  updateLitho: (id: string, patch: Partial<LithoInput>) => Promise<{ log?: LithoLog; conflicts: RangeConflict[] }>;
  removeLitho: (id: string) => Promise<void>;
}

/** 岩性区间与冲突校验 */
export const useLithoStore = create<LithoState>()((set, get) => ({
  lithos: [],
  hydrated: false,

  hydrate: async () => {
    const lithos = await db.lithos.orderBy('fromDepth').toArray();
    set({ lithos, hydrated: true });
  },

  checkConflicts: (input, ignoreId) => {
    const candidate: LithoLog = {
      id: ignoreId ?? 'candidate',
      holeId: input.holeId,
      fromDepth: Number(input.fromDepth) || 0,
      toDepth: Number(input.toDepth) || 0,
      lithology: '花岗闪长岩',
      color: '',
      alteration: '无',
      mineralization: '无',
      rqd: 0,
      sampleNo: '',
      logger: '',
    };
    return findConflicts(candidate, get().lithos);
  },

  addLitho: async (input) => {
    const conflicts = get().checkConflicts(input);
    if (conflicts.length) {
      return { conflicts };
    }
    const log: LithoLog = {
      id: uid('litho'),
      holeId: input.holeId,
      fromDepth: Number(input.fromDepth) || 0,
      toDepth: Number(input.toDepth) || 0,
      lithology: input.lithology,
      color: input.color.trim(),
      alteration: input.alteration,
      mineralization: input.mineralization,
      rqd: Number(input.rqd) || 0,
      sampleNo: input.sampleNo.trim(),
      logger: input.logger.trim(),
      remark: input.remark?.trim() || undefined,
    };
    await db.lithos.put(log);
    set({ lithos: [...get().lithos, log] });
    return { log, conflicts: [] };
  },

  updateLitho: async (id, patch) => {
    const current = get().lithos.find((l) => l.id === id);
    if (!current) return { conflicts: [] };
    const merged = { ...current, ...patch };
    const conflicts = get().checkConflicts(merged, id);
    if (conflicts.length) {
      return { conflicts };
    }
    const next: LithoLog = { ...merged };
    await db.lithos.put(next);
    set({ lithos: get().lithos.map((l) => (l.id === id ? next : l)) });
    return { log: next, conflicts: [] };
  },

  removeLitho: async (id) => {
    await db.lithos.delete(id);
    set({ lithos: get().lithos.filter((l) => l.id !== id) });
  },
}));
