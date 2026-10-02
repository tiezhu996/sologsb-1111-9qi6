/** 实体中文名与关键字段摘要（待处理区展示） */
import type { EntityTable } from '../sync/types';

export const TABLE_LABEL: Record<EntityTable, string> = {
  holes: '钻孔',
  runs: '回次',
  boxes: '岩芯箱',
  lithos: '岩性区间',
};

export const REASON_LABEL: Record<string, { text: string; color: string }> = {
  diverged: { text: '两边都改过', color: 'orange' },
  'remote-deleted': { text: '对方删除 / 本地改动', color: 'volcano' },
  protected: { text: '本地已确认事实受保护', color: 'red' },
  duplicate: { text: '重复箱号 / 岩性区间', color: 'gold' },
};

function num(v: unknown): string {
  if (v === undefined || v === null || v === '') return '—';
  return String(v);
}

/** 取一条记录给编录员看的一行摘要 */
export function entitySummary(table: EntityTable, row: Record<string, unknown> | undefined): string {
  if (!row) return '（无记录）';
  switch (table) {
    case 'holes':
      return `${num(row.holeNo)} · 设计 ${num(row.designDepth)}m · 终孔 ${num(row.finalDepth)}m${row.endDate ? ` · 终孔日 ${num(row.endDate).slice(0, 10)}` : ''}`;
    case 'runs':
      return `${num(row.runNo)} · ${num(row.fromDepth)}~${num(row.toDepth)}m · 采取率 ${num(row.recovery)}%`;
    case 'boxes':
      return `${num(row.boxNo)} · ${num(row.fromDepth)}~${num(row.toDepth)}m · 架位 ${num(row.shelfPos)}`;
    case 'lithos':
      return `${num(row.fromDepth)}~${num(row.toDepth)}m · ${num(row.lithology)}${row.sampleNo ? ` · 样品 ${num(row.sampleNo)}` : ''}`;
    default:
      return num(row.id);
  }
}

/** 字段中文名 */
export function fieldLabel(field: string): string {
  const labels: Record<string, string> = {
    holeNo: '孔号',
    coordX: '坐标 X',
    coordY: '坐标 Y',
    collarElevation: '孔口标高',
    designDepth: '设计孔深',
    finalDepth: '终孔深度',
    startDate: '开孔日期',
    endDate: '终孔日期',
    rigNo: '钻机号',
    shift: '班组',
    remark: '备注',
    runNo: '回次号',
    fromDepth: '起深度',
    toDepth: '止深度',
    footage: '进尺',
    coreLength: '岩芯长度',
    recovery: '采取率',
    waterLevel: '回次水位',
    drilledAt: '钻进日期',
    recorder: '记录人',
    boxNo: '箱号',
    slots: '格数',
    slotLength: '每格长度',
    boxedAt: '装箱日期',
    shelfPos: '库架位',
    damagedSlots: '破损格',
    operator: '装箱人',
    lithology: '岩性',
    color: '颜色',
    alteration: '蚀变',
    mineralization: '矿化',
    rqd: 'RQD',
    sampleNo: '样品号',
    logger: '编录人',
  };
  return labels[field] ?? field;
}

/** 列出本地与对方版本之间所有不同的业务字段 */
export function diffFields(local: Record<string, unknown> | undefined, remote: Record<string, unknown> | undefined): string[] {
  const keys = new Set([...Object.keys(local ?? {}), ...Object.keys(remote ?? {})]);
  return [...keys]
    .filter((k) => !['nodeId', 'vv', 'baseVv', 'updatedAt', 'legacy'].includes(k))
    .filter((k) => JSON.stringify(local?.[k]) !== JSON.stringify(remote?.[k]))
    .sort();
}
