/** 回次水位 */
export type RunShift = '甲班' | '乙班' | '丙班';

/** 钻进回次 */
export interface DrillRun {
  id: string;
  /** 回次号 */
  runNo: string;
  /** 所属钻孔 */
  holeId: string;
  /** 起深度（m） */
  fromDepth: number;
  /** 止深度（m） */
  toDepth: number;
  /** 进尺（m），由起止深度自动计算 */
  footage: number;
  /** 岩芯长度（m） */
  coreLength: number;
  /** 采取率（%），由岩芯长度 / 进尺自动计算 */
  recovery: number;
  /** 回次水位（m） */
  waterLevel: number;
  /** 班次 */
  shift: RunShift;
  /** 钻进日期 ISO */
  drilledAt: string;
  /** 记录人 */
  recorder: string;
  /** 备注 */
  remark?: string;
}

/** 采取率分级 */
export type RecoveryGrade = '优' | '合格' | '异常';

/** 异常回次（采取率低于阈值）派生项 */
export interface RunAnomaly {
  run: DrillRun;
  holeNo: string;
  grade: RecoveryGrade;
  advice: string;
}
