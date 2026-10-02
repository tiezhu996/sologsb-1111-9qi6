/** 钻孔测斜点 */
export interface SurveyPoint {
  id: string;
  /** 测点深度（m） */
  depth: number;
  /** 倾角（°） */
  dip: number;
  /** 方位角（°） */
  azimuth: number;
}

/** 钻孔台帐 */
export interface DrillHole {
  id: string;
  /** 孔号 */
  holeNo: string;
  /** 坐标 X */
  coordX: number;
  /** 坐标 Y */
  coordY: number;
  /** 孔口标高（m） */
  collarElevation: number;
  /** 设计孔深（m） */
  designDepth: number;
  /** 终孔深度（m），未终孔时为 0 */
  finalDepth: number;
  /** 开孔日期 ISO */
  startDate: string;
  /** 终孔日期 ISO，未终孔为空 */
  endDate?: string;
  /** 钻机号 */
  rigNo: string;
  /** 施工班组 */
  shift: string;
  /** 测斜数据 */
  surveyData: SurveyPoint[];
  /** 备注 */
  remark?: string;
}

export const RIG_NOS: string[] = ['XY-1', 'XY-2', 'XY-4', 'HGY-300'];
export const SHIFTS: string[] = ['甲班', '乙班', '丙班'];

/** 钻孔进度派生值 */
export interface HoleProgress {
  hole: DrillHole;
  /** 已完成（终孔）深度 */
  reachedDepth: number;
  /** 设计孔深达成率（%） */
  designRatio: number;
  /** 是否终孔 */
  finished: boolean;
  /** 是否未达设计（终孔深度 < 设计孔深） */
  belowDesign: boolean;
  /** 是否需要补勘 */
  needSupplement: boolean;
}
