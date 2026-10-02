import { Empty, Space, Typography } from 'antd';
import { LITHO_COLOR, type LithoLog } from '../../types/litho-log';
import type { DrillRun } from '../../types/drill-run';

const { Text } = Typography;

export interface LithoColumnProps {
  logs: LithoLog[];
  runs?: DrillRun[];
  /** 柱状图最大深度（m），默认取最大编录深度 */
  maxDepth?: number;
  height?: number;
}

const COLUMN_X = 90;
const COLUMN_W = 78;

/**
 * 岩性柱状图：按深度区间绘制岩性色块并叠加样品位与回次采取率异常段。
 * 被岩性编录页消费。
 */
export default function LithoColumn({ logs, runs = [], maxDepth, height = 460 }: LithoColumnProps) {
  if (logs.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可绘制的岩性区间" />;
  }

  const depthMax = maxDepth && maxDepth > 0 ? maxDepth : Math.max(...logs.map((log) => log.toDepth));
  const scale = (depth: number) => (depth / depthMax) * height;
  const tickStep = depthMax > 300 ? 50 : depthMax > 150 ? 25 : 20;
  const ticks: number[] = [];
  for (let d = 0; d <= depthMax + 0.001; d += tickStep) {
    ticks.push(Number(d.toFixed(0)));
  }

  const samples = logs.filter((log) => log.sampleNo);
  const abnormalRuns = runs.filter((run) => run.recovery < 75);

  return (
    <div style={{ background: '#fff', border: '1px solid #dbe4ea', borderRadius: 8, padding: 12 }}>
      <Space size={12} wrap style={{ marginBottom: 8 }}>
        <Text strong>岩性柱状图（0~{depthMax}m）</Text>
        <Text type="secondary">样品位 {samples.length} 个 · 采取率异常段 {abnormalRuns.length} 段</Text>
      </Space>
      <svg viewBox={`0 0 360 ${height + 40}`} style={{ width: '100%', maxWidth: 460, height: 'auto' }} role="img" aria-label="岩性柱状图">
        {/* 深度轴 */}
        <line x1={COLUMN_X - 12} y1={0} x2={COLUMN_X - 12} y2={height} stroke="#b9c6d0" />
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={COLUMN_X - 16} y1={scale(tick)} x2={COLUMN_X - 8} y2={scale(tick)} stroke="#b9c6d0" />
            <text x={COLUMN_X - 20} y={scale(tick) + 4} textAnchor="end" fontSize="10" fill="#6b7a86">
              {tick}m
            </text>
          </g>
        ))}

        {/* 岩性色块 */}
        {logs.map((log) => {
          const y = scale(log.fromDepth);
          const h = Math.max(6, scale(log.toDepth) - scale(log.fromDepth));
          return (
            <g key={log.id}>
              <rect x={COLUMN_X} y={y} width={COLUMN_W} height={h} fill={LITHO_COLOR[log.lithology]} stroke="#8a99a5" />
              <text x={COLUMN_X + COLUMN_W / 2} y={y + h / 2 + 4} textAnchor="middle" fontSize="10" fill="#33414d">
                {log.lithology.slice(0, 4)}
              </text>
              <text x={COLUMN_X + COLUMN_W + 8} y={y + 12} fontSize="10" fill="#6b7a86">
                {log.fromDepth}~{log.toDepth}m {log.alteration !== '无' ? `· ${log.alteration}` : ''}
                {log.mineralization !== '无' ? ` · ${log.mineralization}` : ''}
              </text>
            </g>
          );
        })}

        {/* 样品位 */}
        {samples.map((log) => {
          const y = scale((log.fromDepth + log.toDepth) / 2);
          return (
            <g key={`sample-${log.id}`}>
              <polygon points={`${COLUMN_X + COLUMN_W + 2},${y - 5} ${COLUMN_X + COLUMN_W + 9},${y} ${COLUMN_X + COLUMN_W + 2},${y + 5} ${COLUMN_X + COLUMN_W - 5},${y}`} fill="#c62828" />
              <text x={COLUMN_X + COLUMN_W + 14} y={y + 4} fontSize="10" fill="#c62828">
                {log.sampleNo} · RQD {log.rqd}%
              </text>
            </g>
          );
        })}

        {/* 采取率异常段 */}
        {abnormalRuns.map((run) => (
          <line
            key={`abn-${run.id}`}
            x1={COLUMN_X - 4}
            y1={scale(run.fromDepth)}
            x2={COLUMN_X - 4}
            y2={scale(run.toDepth)}
            stroke="#cf1322"
            strokeWidth={3}
            strokeLinecap="round"
          />
        ))}
      </svg>
    </div>
  );
}
