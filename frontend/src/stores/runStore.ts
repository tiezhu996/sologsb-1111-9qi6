import { create } from 'zustand';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import type { DrillRun, RunAnomaly, RunShift } from '../types/drill-run';
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
  runs: DrillRun[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addRun: (input: RunInput) => Promise<DrillRun>;
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
    const footage = footageOf(input.fromDepth, input.toDepth);
    const run: DrillRun = {
      id: uid('run'),
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
    };
    await db.runs.put(run);
    set({ runs: [run, ...get().runs] });
    return run;
  },

  updateRun: async (id, patch) => {
    const current = get().runs.find((r) => r.id === id);
    if (!current) return;
    const merged = { ...current, ...patch };
    const footage = footageOf(merged.fromDepth, merged.toDepth);
    const next: DrillRun = {
      ...merged,
      footage,
      recovery: recoveryOf(merged.coreLength, footage),
    };
    await db.runs.put(next);
    set({ runs: get().runs.map((r) => (r.id === id ? next : r)) });
  },

  removeRun: async (id) => {
    await db.runs.delete(id);
    set({ runs: get().runs.filter((r) => r.id !== id) });
  },

  removeByHole: async (holeId) => {
    const ids = get().runs.filter((r) => r.holeId === holeId).map((r) => r.id);
    await db.runs.bulkDelete(ids);
    set({ runs: get().runs.filter((r) => r.holeId !== holeId) });
  },
}));

/** 采取率异常清单（低于 75% 判异常） */
export function anomalyList(runs: DrillRun[], holeNoOf: (holeId: string) => string): RunAnomaly[] {
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
