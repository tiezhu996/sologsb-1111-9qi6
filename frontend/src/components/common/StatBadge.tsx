import { Card, Tooltip } from 'antd';
import type { ReactNode } from 'react';

export type StatBadgeStatus = 'default' | 'success' | 'warning' | 'error';

export interface StatBadgeProps {
  label: string;
  value: ReactNode;
  unit?: string;
  status?: StatBadgeStatus;
  hint?: string;
}

const STATUS_COLOR: Record<StatBadgeStatus, string> = {
  default: '#2b3a46',
  success: '#237804',
  warning: '#d48806',
  error: '#cf1322',
};

/** 关键指标小卡片（工作台、岩芯箱页复用） */
export default function StatBadge({ label, value, unit, status = 'default', hint }: StatBadgeProps) {
  const body = (
    <Card size="small" styles={{ body: { padding: '10px 14px' } }} style={{ borderLeft: `3px solid ${STATUS_COLOR[status]}` }}>
      <div style={{ fontSize: 12, color: '#6b7a86' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color: STATUS_COLOR[status], lineHeight: 1.4 }}>
        {value}
        {unit ? <span style={{ fontSize: 12, marginLeft: 4, color: '#6b7a86' }}>{unit}</span> : null}
      </div>
    </Card>
  );
  return hint ? <Tooltip title={hint}>{body}</Tooltip> : body;
}
