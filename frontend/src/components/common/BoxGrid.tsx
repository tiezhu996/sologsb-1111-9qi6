import { Badge, Space, Tooltip, Typography } from 'antd';
import type { CoreBox } from '../../types/core-box';
import type { DrillRun } from '../../types/drill-run';

const { Text } = Typography;

export interface BoxGridProps {
  box: CoreBox;
  runs?: DrillRun[];
  onToggleDamaged?: (slot: number) => void;
  compact?: boolean;
}

/**
 * 岩芯箱格位网格：按深度填充每格并标注破损格，
 * 未被回次覆盖的格位以虚线标出（装箱断档）。被岩芯箱编目页消费。
 */
export default function BoxGrid({ box, runs = [], onToggleDamaged, compact = false }: BoxGridProps) {
  const holeRuns = runs.filter((run) => run.holeId === box.holeId);
  const total = box.slots;
  const cells = Array.from({ length: total }, (_, index) => {
    const slot = index + 1;
    const from = Number((box.fromDepth + index * box.slotLength).toFixed(2));
    const to = Number(Math.min(from + box.slotLength, box.toDepth).toFixed(2));
    const covered = holeRuns.some((run) => Math.min(run.toDepth, to) - Math.max(run.fromDepth, from) > 0.0001);
    return { slot, from, to, covered, damaged: box.damagedSlots.includes(slot) };
  });

  const damaged = cells.filter((c) => c.damaged).length;
  const gaps = cells.filter((c) => !c.covered).length;

  return (
    <div>
      <Space size={12} wrap style={{ marginBottom: 6 }}>
        <Text type="secondary">
          箱号 {box.boxNo} · {box.fromDepth}~{box.toDepth}m · {box.slots} 格 × {box.slotLength}m
        </Text>
        <Badge color="#237804" text={`已填充 ${total - gaps} 格`} />
        {gaps > 0 ? <Badge color="#d48806" text={`断档 ${gaps} 格`} /> : null}
        {damaged > 0 ? <Badge color="#cf1322" text={`破损 ${damaged} 格`} /> : null}
      </Space>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${compact ? 10 : 12}, minmax(0, 1fr))`, gap: 4 }}>
        {cells.map((cell) => {
          const background = cell.damaged ? '#cf1322' : cell.covered ? '#5b7c8d' : '#f4f7f9';
          const color = cell.damaged || cell.covered ? '#fff' : '#8a99a5';
          return (
            <Tooltip
              key={cell.slot}
              title={`第 ${cell.slot} 格 · ${cell.from}~${cell.to}m · ${
                cell.damaged ? '破损（岩芯缺失）' : cell.covered ? '已装岩芯' : '无对应回次（断档）'
              }${onToggleDamaged ? ' · 点击切换破损标记' : ''}`}
            >
              <div
                onClick={() => onToggleDamaged?.(cell.slot)}
                style={{
                  cursor: onToggleDamaged ? 'pointer' : 'default',
                  border: cell.covered ? '1px solid #4a6b7c' : '1px dashed #b9c6d0',
                  borderRadius: 4,
                  background,
                  color,
                  fontSize: 11,
                  padding: '4px 2px',
                  textAlign: 'center',
                  lineHeight: 1.4,
                }}
              >
                <div style={{ fontWeight: 600 }}>{cell.slot}</div>
                <div>{cell.from}~{cell.to}</div>
              </div>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}
