import { Alert, InputNumber, Space, Tag, Typography } from 'antd';
import type { DrillRun } from '../../types/drill-run';
import { footageOf, validateRange } from '../../utils/recovery';

const { Text } = Typography;

export interface DepthRangeInputProps {
  fromDepth: number;
  toDepth: number;
  onChange: (patch: { fromDepth?: number; toDepth?: number }) => void;
  /** 该孔已有回次，用于提示与既有区间的关系 */
  referenceRuns?: DrillRun[];
  /** 当前记录自身的 id（编辑时排除自身） */
  ignoreRunId?: string;
  /** 深度上限（设计孔深） */
  maxDepth?: number;
  disabled?: boolean;
}

/**
 * 起止深度双输入：校验顺序与既有区间重叠，并实时输出进尺。
 * 被回次记录页、岩芯箱页、岩性编录页消费。
 */
export default function DepthRangeInput({
  fromDepth,
  toDepth,
  onChange,
  referenceRuns = [],
  ignoreRunId,
  maxDepth,
  disabled = false,
}: DepthRangeInputProps) {
  const footage = footageOf(fromDepth, toDepth);
  const error = validateRange(Number(fromDepth), Number(toDepth));
  const overlapped = referenceRuns
    .filter((run) => run.id !== ignoreRunId)
    .filter((run) => Math.min(run.toDepth, Number(toDepth)) - Math.max(run.fromDepth, Number(fromDepth)) > 0.0001);
  const beyondMax = typeof maxDepth === 'number' && maxDepth > 0 && Number(toDepth) > maxDepth;

  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      <Space wrap size={8} align="center">
        <span style={{ color: '#6b7a86' }}>起深度</span>
        <InputNumber
          min={0}
          step={0.5}
          value={fromDepth}
          addonAfter="m"
          style={{ width: 150 }}
          disabled={disabled}
          placeholder="起深度"
          onChange={(value) => onChange({ fromDepth: Number(value) || 0 })}
        />
        <span style={{ color: '#6b7a86' }}>止深度</span>
        <InputNumber
          min={0}
          step={0.5}
          value={toDepth}
          addonAfter="m"
          style={{ width: 150 }}
          disabled={disabled}
          placeholder="止深度"
          onChange={(value) => onChange({ toDepth: Number(value) || 0 })}
        />
        <Text strong>进尺 {footage} m</Text>
      </Space>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      {!error && overlapped.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={
            <span>
              与既有回次深度重叠：
              {overlapped.map((run) => (
                <Tag key={run.id} color="orange" style={{ marginLeft: 4 }}>
                  {run.runNo} {run.fromDepth}~{run.toDepth}m
                </Tag>
              ))}
            </span>
          }
        />
      ) : null}
      {!error && beyondMax ? (
        <Alert type="warning" showIcon message={`止深度 ${toDepth}m 超过设计孔深 ${maxDepth}m`} />
      ) : null}
    </Space>
  );
}
