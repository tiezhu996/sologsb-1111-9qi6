import { Button, Empty } from 'antd';
import type { ReactNode } from 'react';

export interface EmptyPanelProps {
  description: string;
  actionText?: string;
  onAction?: () => void;
  children?: ReactNode;
}

/** 空状态面板（钻孔台帐、岩芯箱页复用） */
export default function EmptyPanel({ description, actionText, onAction, children }: EmptyPanelProps) {
  return (
    <div style={{ padding: '32px 16px', background: '#fff', borderRadius: 8, border: '1px dashed #c3cfd8' }}>
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span style={{ color: '#6b7a86' }}>{description}</span>}>
        {actionText && onAction ? (
          <Button type="primary" onClick={onAction}>
            {actionText}
          </Button>
        ) : null}
        {children}
      </Empty>
    </div>
  );
}
