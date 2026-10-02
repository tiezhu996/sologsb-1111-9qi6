import { Tooltip, Typography } from 'antd';
import { CloudServerOutlined } from '@ant-design/icons';
import { LEGACY_NODE_ID } from '../../sync/clock';

const { Text } = Typography;

/** 记录来源徽标：显示来源节点编号；旧数据回填的公共祖先用灰色「旧库」标记 */
export default function SourceTag({
  nodeId,
  legacy,
  updatedAt,
}: {
  nodeId?: string;
  legacy?: boolean;
  updatedAt?: string;
}) {
  if (!nodeId) return <Text type="secondary">—</Text>;
  if (nodeId === LEGACY_NODE_ID) {
    return (
      <Tooltip title={updatedAt ? `旧版数据兼容回填（${updatedAt.slice(0, 10)}）` : '旧版数据兼容回填，来源待同步确认'}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          <CloudServerOutlined /> 旧库
        </Text>
      </Tooltip>
    );
  }
  return (
    <Tooltip title={updatedAt ? `来源 ${nodeId} · 更新于 ${updatedAt.slice(0, 16).replace('T', ' ')}` : `来源 ${nodeId}`}>
      <Text style={{ fontSize: 12 }}>
        <CloudServerOutlined /> {nodeId}
      </Text>
    </Tooltip>
  );
}
