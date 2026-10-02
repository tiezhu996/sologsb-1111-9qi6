import { Button, Input, Select, Space, Tag } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useSearchParams } from 'react-router-dom';

export interface FilterField {
  key: string;
  label: string;
  options: string[];
  width?: number;
}

export interface FilterBarProps {
  fields: FilterField[];
  keywordKey?: string;
  keywordPlaceholder?: string;
  resultCount?: number;
  totalCount?: number;
  extra?: React.ReactNode;
}

/** 关键字与多选条件过滤条：条件同步 URL query（钻孔台帐、回次记录页复用） */
export default function FilterBar({
  fields,
  keywordKey = 'kw',
  keywordPlaceholder = '搜索孔号 / 钻机 / 备注',
  resultCount,
  totalCount,
  extra,
}: FilterBarProps) {
  const [params, setParams] = useSearchParams();

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const reset = () => {
    const next = new URLSearchParams(params);
    [keywordKey, ...fields.map((f) => f.key)].forEach((key) => next.delete(key));
    setParams(next, { replace: true });
  };

  const activeCount = [keywordKey, ...fields.map((f) => f.key)].filter((key) => params.get(key)).length;

  return (
    <Space wrap size={[8, 8]} style={{ marginBottom: 12 }} align="center">
      <Input.Search
        allowClear
        style={{ width: 240 }}
        placeholder={keywordPlaceholder}
        defaultValue={params.get(keywordKey) ?? ''}
        key={params.get(keywordKey) ?? ''}
        onSearch={(value) => update(keywordKey, value.trim())}
      />
      {fields.map((field) => (
        <span key={field.key}>
          <span style={{ color: '#6b7a86', marginRight: 6 }}>{field.label}</span>
          <Select
            allowClear
            style={{ width: field.width ?? 120 }}
            placeholder="全部"
            value={params.get(field.key) ?? undefined}
            options={field.options.map((option) => ({ label: option, value: option }))}
            onChange={(value?: string) => update(field.key, value ?? '')}
          />
        </span>
      ))}
      <Button icon={<ReloadOutlined />} onClick={reset} disabled={activeCount === 0}>
        重置
      </Button>
      {typeof resultCount === 'number' && typeof totalCount === 'number' ? (
        <Tag color={resultCount === totalCount ? 'default' : 'blue'}>
          命中 {resultCount} / {totalCount}
        </Tag>
      ) : null}
      {extra}
    </Space>
  );
}
