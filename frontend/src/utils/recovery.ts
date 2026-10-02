import type { HoleProgress, DrillHole } from '../types/drill-hole';
import type { DrillRun, RecoveryGrade } from '../types/drill-run';
import type { CoreBox, BoxContinuity } from '../types/core-box';
import type { LithoLog, RangeConflict } from '../types/litho-log';

/** 采取率分级阈值（%）：≥90 优 / 75~90 合格 / <75 异常 */
export const RECOVERY_THRESHOLDS = { excellent: 90, qualified: 75 } as const;

/** 采取率分级文案与处置建议 */
export const RECOVERY_GRADE_TEXT: Record<RecoveryGrade, { color: string; advice: string }> = {
  优: { color: 'green', advice: '采取率优良，正常编录装箱' },
  合格: { color: 'blue', advice: '采取率合格，留意岩芯破碎段' },
  异常: { color: 'red', advice: '采取率低于 75%，排查钻进工艺并记为质量异常' },
};

export function gradeOf(recovery: number): RecoveryGrade {
  if (recovery >= RECOVERY_THRESHOLDS.excellent) return '优';
  if (recovery >= RECOVERY_THRESHOLDS.qualified) return '合格';
  return '异常';
}

export function isAnomaly(recovery: number): boolean {
  return recovery < RECOVERY_THRESHOLDS.qualified;
}

/** 进尺 = 止深度 - 起深度 */
export function footageOf(fromDepth: number, toDepth: number): number {
  return Number(Math.max(0, (Number(toDepth) || 0) - (Number(fromDepth) || 0)).toFixed(2));
}

/** 采取率 = 岩芯长度 / 进尺 × 100 */
export function recoveryOf(coreLength: number, footage: number): number {
  if (!footage || footage <= 0) return 0;
  return Number((((Number(coreLength) || 0) / footage) * 100).toFixed(1));
}

/** 两个深度区间是否重叠（端点相接不算重叠） */
export function rangesOverlap(aFrom: number, aTo: number, bFrom: number, bTo: number): boolean {
  return Math.min(aTo, bTo) - Math.max(aFrom, bFrom) > 0.0001;
}

export function overlapRange(aFrom: number, aTo: number, bFrom: number, bTo: number): { from: number; to: number } | null {
  const from = Math.max(aFrom, bFrom);
  const to = Math.min(aTo, bTo);
  return to - from > 0.0001 ? { from: Number(from.toFixed(2)), to: Number(to.toFixed(2)) } : null;
}

/** 区间顺序校验：起深度必须小于止深度且深度非负 */
export function validateRange(fromDepth: number, toDepth: number): string | undefined {
  if (Number.isNaN(fromDepth) || Number.isNaN(toDepth)) return '深度必须为数字';
  if (fromDepth < 0) return '起深度不能为负';
  if (toDepth <= fromDepth) return '止深度必须大于起深度';
  return undefined;
}

/** 岩性区间冲突检测：与同孔已编录区间重叠即冲突 */
export function findConflicts(candidate: LithoLog, existing: LithoLog[]): RangeConflict[] {
  return existing
    .filter((log) => log.id !== candidate.id && log.holeId === candidate.holeId)
    .map((log) => {
      const overlap = overlapRange(candidate.fromDepth, candidate.toDepth, log.fromDepth, log.toDepth);
      return overlap ? { current: candidate, other: log, overlapFrom: overlap.from, overlapTo: overlap.to } : null;
    })
    .filter((item): item is RangeConflict => item !== null);
}

/** 合并深度区间（用于覆盖计算） */
export function mergeRanges(ranges: Array<{ from: number; to: number }>): Array<{ from: number; to: number }> {
  const sorted = [...ranges].filter((r) => r.to > r.from).sort((a, b) => a.from - b.from);
  const merged: Array<{ from: number; to: number }> = [];
  sorted.forEach((range) => {
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to + 0.0001) {
      last.to = Math.max(last.to, range.to);
    } else {
      merged.push({ ...range });
    }
  });
  return merged;
}

/** [fromDepth, toDepth] 内未被覆盖的断档区间 */
export function gapsWithin(fromDepth: number, toDepth: number, runs: DrillRun[]): Array<{ from: number; to: number }> {
  const merged = mergeRanges(runs.map((run) => ({ from: run.fromDepth, to: run.toDepth })));
  const gaps: Array<{ from: number; to: number }> = [];
  let cursor = fromDepth;
  merged.forEach((range) => {
    if (range.to <= cursor) return;
    if (range.from > cursor) {
      gaps.push({ from: Number(cursor.toFixed(2)), to: Number(Math.min(range.from, toDepth).toFixed(2)) });
    }
    cursor = Math.max(cursor, range.to);
  });
  if (cursor < toDepth - 0.0001) {
    gaps.push({ from: Number(cursor.toFixed(2)), to: Number(toDepth.toFixed(2)) });
  }
  return gaps.filter((gap) => gap.to - gap.from > 0.0001);
}

/** 已钻进深度（最大止深度） */
export function reachedDepthOf(runs: DrillRun[]): number {
  return Number(runs.reduce((max, run) => Math.max(max, run.toDepth), 0).toFixed(2));
}

/** 钻孔进度派生：终孔深度 / 设计孔深 / 未达设计 / 待补勘 */
export function buildHoleProgress(hole: DrillHole, runs: DrillRun[]): HoleProgress {
  const reachedDepth = Math.max(hole.finalDepth || 0, reachedDepthOf(runs));
  const designRatio = hole.designDepth > 0 ? Number(((reachedDepth / hole.designDepth) * 100).toFixed(1)) : 0;
  const finished = Boolean(hole.endDate);
  const belowDesign = finished && hole.finalDepth > 0 && hole.finalDepth < hole.designDepth;
  return {
    hole,
    reachedDepth,
    designRatio,
    finished,
    belowDesign,
    needSupplement: belowDesign,
  };
}

/** 岩芯箱深度连续性校验：区间是否被回次完整覆盖 */
export function checkBoxContinuity(box: CoreBox, runs: DrillRun[]): BoxContinuity {
  const holeRuns = runs.filter((run) => run.holeId === box.holeId);
  const gaps = gapsWithin(box.fromDepth, box.toDepth, holeRuns);
  const covered = gaps.length === 0;
  return {
    box,
    covered,
    gaps,
    message: covered
      ? `深度 ${box.fromDepth}~${box.toDepth}m 已被回次完整覆盖`
      : `深度 ${gaps.map((g) => `${g.from}~${g.to}m`).join('、')} 无对应回次，装箱档位断档`,
  };
}

/** 格位容量校验：格数 × 每格长度 应不小于区间长度 */
export function boxCapacityOk(box: CoreBox): boolean {
  return box.slots * box.slotLength + 0.0001 >= box.toDepth - box.fromDepth;
}

/** 破损格数量 */
export function damagedCount(box: CoreBox): number {
  return box.damagedSlots.length;
}
