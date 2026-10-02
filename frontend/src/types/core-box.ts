/** 岩芯箱 */
export interface CoreBox {
  id: string;
  /** 箱号 */
  boxNo: string;
  /** 所属钻孔 */
  holeId: string;
  /** 起始深度（m） */
  fromDepth: number;
  /** 终止深度（m） */
  toDepth: number;
  /** 格数 */
  slots: number;
  /** 每格长度（m） */
  slotLength: number;
  /** 装箱日期 ISO */
  boxedAt: string;
  /** 库架位 */
  shelfPos: string;
  /** 破损格（格序号，从 1 开始） */
  damagedSlots: number[];
  /** 装箱人 */
  operator: string;
  /** 备注 */
  remark?: string;
}

/** 岩芯箱与回次的连续性校验结果 */
export interface BoxContinuity {
  box: CoreBox;
  /** 区间是否被回次完整覆盖 */
  covered: boolean;
  /** 断档区间（未被回次覆盖的深度段） */
  gaps: Array<{ from: number; to: number }>;
  /** 提示文案 */
  message: string;
}

export const SHELF_POSITIONS: string[] = ['A 区 1 架', 'A 区 2 架', 'B 区 1 架', 'B 区 2 架', 'C 区 1 架'];
