import { create } from 'zustand';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { deleteStamped, putStamped } from '../sync/syncDb';
import type { DrillRun, RunAnomaly, RunShift } from '../types/drill-run';
import type { StampedEntity } from '../sync/types';
import { footageOf, gradeOf, isAnomaly, recoveryOf, RECOVERY_GRADE_TEXT } from '../utils/recovery';

export interface RunInput {
  runNo: string;
  holeId: string;
  fromDepth: number;
  toDepth: number;
  coreLength: number;
  waterLevel: number;
  shift: RunShift;
  drilledAt: string;
  recorder: string;
  remark?: string;
}

interface RunState {
  runs: StampedEntity<DrillRun>[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addRun: (input: RunInput) => Promise<StampedEntity<DrillRun>>;
  updateRun: (id: string, patch: Partial<RunInput>) => Promise<void>;
  removeRun: (id: string) => Promise<void>;
  removeByHole: (holeId: string) => Promise<void>;
}

/** 回次与采取率派生值：进尺与采取率均由起止深度、岩芯长度自动计算 */
export const useRunStore = create<RunState>()((set, get) => ({
  runs: [],
  hydrated: false,

  hydrate: async () => {
    const runs = await db.runs.orderBy('fromDepth').toArray();
    set({ runs, hydrated: true });
  },

  addRun: async (input) => {
    const id = uid('run');
    const footage = footageOf(input.fromDepth, input.toDepth);
    let run: StampedEntity<DrillRun> | undefined;
    await putStamped<DrillRun>('runs', id, (stamp) => {
      run = {
        id,
        runNo: input.runNo.trim(),
        holeId: input.holeId,
        fromDepth: Number(input.fromDepth) || 0,
        toDepth: Number(input.toDepth) || 0,
        footage,
        coreLength: Number(input.coreLength) || 0,
        recovery: recoveryOf(input.coreLength, footage),
        waterLevel: Number(input.waterLevel) || 0,
        shift: input.shift,
        drilledAt: input.drilledAt,
        recorder: input.recorder.trim(),
        remark: input.remark?.trim() || undefined,
        ...stamp,
      };
      return run;
    });
    set({ runs: [run as StampedEntity<DrillRun>, ...get().runs] });
    return run as StampedEntity<DrillRun>;
  },

  updateRun: async (id, patch) => {
    const current = get().runs.find((r) => r.id === id);
    if (!current) return;
    let next!: StampedEntity<DrillRun>;
    await putStamped<DrillRun>('runs', id, (stamp) => {
      const merged = { ...current, ...patch, id };
      const footage = footageOf(merged.fromDepth, merged.toDepth);
      next = {
        ...merged,
        footage,
        recovery: recoveryOf(merged.coreLength, footage),
        ...stamp,
      };
      return next;
    });
    set({ runs: get().runs.map((r) => (r.id === id ? next : r)) });
  },

  removeRun: async (id) => {
    await deleteStamped('runs', id);
    set({ runs: get().runs.filter((r) => r.id !== id) });
  },

  removeByHole: async (holeId) => {
    const ids = get().runs.filter((r) => r.holeId === holeId).map((r) => r.id);
    // 逐条逻辑删除：每个回次各写墓碑，删除事实可随差量包同步
    for (const runId of ids) {
      await deleteStamped('runs', runId);
    }
    set({ runs: get().runs.filter((r) => r.holeId !== holeId) });
  },
}));

/** 采取率异常清单（低于 75% 判异常） */
export function anomalyList(runs: StampedEntity<DrillRun>[], holeNoOf: (holeId: string) => string): RunAnomaly[] {
  return runs
    .filter((run) => isAnomaly(run.recovery))
    .map((run) => ({
      run,
      holeNo: holeNoOf(run.holeId),
      grade: gradeOf(run.recovery),
      advice: RECOVERY_GRADE_TEXT.异常.advice,
    }))
    .sort((a, b) => a.run.recovery - b.run.recovery);
}
