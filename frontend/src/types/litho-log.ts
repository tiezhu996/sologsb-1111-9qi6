/** 岩性 */
export type Lithology = '花岗闪长岩' | '大理岩' | '矽卡岩' | '断层角砾岩' | '第四系覆盖层';

/** 蚀变类型 */
export type Alteration = '无' | '硅化' | '绿泥石化' | '碳酸盐化' | '矽卡岩化';

/** 矿化类型 */
export type Mineralization = '无' | '黄铜矿' | '磁铁矿' | '黄铁矿' | '方铅矿';

/** 岩性描述编录（按深度区间） */
export interface LithoLog {
  id: string;
  /** 所属钻孔 */
  holeId: string;
  /** 起始深度（m） */
  fromDepth: number;
  /** 终止深度（m） */
  toDepth: number;
  /** 岩性 */
  lithology: Lithology;
  /** 颜色 */
  color: string;
  /** 蚀变 */
  alteration: Alteration;
  /** 矿化 */
  mineralization: Mineralization;
  /** RQD（%） */
  rqd: number;
  /** 样品号 */
  sampleNo: string;
  /** 编录人 */
  logger: string;
  /** 备注 */
  remark?: string;
}

/** 区间冲突 */
export interface RangeConflict {
  current: LithoLog;
  other: LithoLog;
  overlapFrom: number;
  overlapTo: number;
}

export const LITHOLOGIES: Lithology[] = ['花岗闪长岩', '大理岩', '矽卡岩', '断层角砾岩', '第四系覆盖层'];
export const ALTERATIONS: Alteration[] = ['无', '硅化', '绿泥石化', '碳酸盐化', '矽卡岩化'];
export const MINERALIZATIONS: Mineralization[] = ['无', '黄铜矿', '磁铁矿', '黄铁矿', '方铅矿'];

/** 岩性柱状图配色 */
export const LITHO_COLOR: Record<Lithology, string> = {
  花岗闪长岩: '#c98a7a',
  大理岩: '#cfd8dc',
  矽卡岩: '#8fb98a',
  断层角砾岩: '#b0a08c',
  第四系覆盖层: '#e0cf9a',
};
