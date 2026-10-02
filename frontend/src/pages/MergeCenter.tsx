import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Modal,
  Radio,
  Row,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  CheckCircleTwoTone,
  CloudUploadOutlined,
  ImportOutlined,
  LockTwoTone,
  PauseCircleTwoTone,
  SafetyCertificateTwoTone,
} from '@ant-design/icons';
import { buildDeltaPackage, deltaFileName, listPeers, parseDeltaPackage, type DeltaPackage, type PeerInfo, type TableKey } from '../utils/deltaPackage';
import { downloadText } from '../utils/export';
import { getDeviceIdentity, renameDevice } from '../utils/db';
import { stageReconciliation } from '../utils/mergeIO';
import { useMergeSession } from '../hooks/useMergeSession';
import { FIELD_LABELS, rowTitle, type ItemStatus, type ReconcileItem, type ResolutionChoice } from '../utils/merge';

const { Title, Text, Paragraph } = Typography;

const STATUS_META: Record<ItemStatus, { color: string; text: string }> = {
  auto: { color: 'green', text: '自动合并' },
  pending: { color: 'orange', text: '待处理' },
  held: { color: 'gold', text: '挂起隔离' },
  ignore: { color: 'default', text: '保留本机' },
};

const TABLE_TABS: Array<{ key: TableKey; label: string }> = [
  { key: 'holes', label: '钻孔' },
  { key: 'runs', label: '回次' },
  { key: 'boxes', label: '岩芯箱' },
  { key: 'lithos', label: '岩性区间' },
];

/** 字段值简明展示 */
function formatValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (Array.isArray(value)) {
    if (value.length === 0) return '—';
    if (typeof value[0] === 'object') return `${value.length} 项`;
    return value.join('、');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** 本机 / 导入版本逐字段对照 */
function VersionDiff({ item }: { item: ReconcileItem }) {
  const local = item.localRow;
  const incoming = item.incomingRow;
  const labels = FIELD_LABELS[item.table];
  const keys = Array.from(new Set([...(local ? Object.keys(local) : []), ...(incoming ? Object.keys(incoming) : [])])).filter(
    (key) => key !== 'id' && key !== '_origin',
  );

  const columns: TableColumnsType<{ field: string; local: unknown; incoming: unknown; changed: boolean }> = [
    {
      title: '字段',
      dataIndex: 'field',
      width: 130,
      render: (field: string) => labels[field] ?? field,
    },
    {
      title: <Text strong>本机版本</Text>,
      dataIndex: 'local',
      render: (value, row) =>
        protectedFields.has(labels[row.field]) ? (
          <Text strong style={{ color: '#d4380d' }}>
            <LockTwoTone twoToneColor="#d4380d" /> {formatValue(value)}（锁定）
          </Text>
        ) : (
          <Text type={row.changed ? undefined : 'secondary'}>{formatValue(value)}</Text>
        ),
    },
    {
      title: <Text strong>导入版本</Text>,
      dataIndex: 'incoming',
      render: (value, row) =>
        row.changed ? <Text strong>{formatValue(value)}</Text> : <Text type="secondary">{formatValue(value)}</Text>,
    },
  ];

  const data = keys
    .map((field) => ({
      field,
      local: local?.[field],
      incoming: incoming?.[field],
      changed: JSON.stringify(local?.[field] ?? null) !== JSON.stringify(incoming?.[field] ?? null),
    }))
    .filter((row) => row.changed || labels[row.field]);

  const protectedFields = new Set(item.protectedFields ?? []);
  return (
    <div>
      {item.protectedFields?.length ? (
        <Alert
          style={{ marginBottom: 12 }}
          type="warning"
          showIcon
          icon={<LockTwoTone twoToneColor="#d48806" />}
          message={`本机已确认事实受保护：${item.protectedFields.join('、')}。这些字段始终保留本机值；如需导入其余字段请选「并入非保护字段」。`}
        />
      ) : null}
      <Table
        rowKey="field"
        size="small"
        pagination={false}
        columns={columns}
        dataSource={data}
        rowClassName={(row) => (protectedFields.has(labels[row.field]) ? 'merge-protected-row' : row.changed ? 'merge-changed-row' : '')}
      />
    </div>
  );
}

/** 待处理项决议弹窗 */
function ResolveModal({
  item,
  choice,
  onClose,
  onSubmit,
}: {
  item: ReconcileItem | null;
  choice?: ResolutionChoice;
  onClose: () => void;
  onSubmit: (choice: ResolutionChoice) => void;
}) {
  const [value, setValue] = useState<ResolutionChoice>('keep-local');

  useEffect(() => {
    if (item) setValue(choice ?? 'keep-local');
  }, [item, choice]);

  if (!item) return null;
  const current = choice ?? value;

  const isDelete = item.incomingRow === undefined;
  const upsertOptions: Array<{ value: ResolutionChoice; label: string; disabled?: boolean }> = item.hardProtected
    ? [
        { value: 'keep-local', label: '保留本机版本（含终孔/样品事实）' },
        { value: 'take-incoming', label: '整行采用导入版本', disabled: true },
        { value: 'merge-incoming-nonprotected', label: '并入导入的非保护字段（终孔深度/终孔日期/样品号保留本机）' },
      ]
    : [
        { value: 'keep-local', label: '保留本机版本' },
        { value: 'take-incoming', label: '整行采用导入版本' },
      ];
  const options: Array<{ value: ResolutionChoice; label: string; disabled?: boolean }> = isDelete
    ? [
        { value: 'keep-local', label: '保留本机记录（不删除）' },
        { value: 'confirm-delete', label: '确认按导入包删除' },
      ]
    : upsertOptions;

  return (
    <Modal
      open
      width={760}
      title={
        <Space>
          <SafetyCertificateTwoTone twoToneColor={item.hardProtected ? '#d4380d' : '#fa8c16'} />
          {TABLE_TABS.find((tab) => tab.key === item.table)?.label}对账：{rowTitle(item.table, item.localRow ?? item.incomingRow)}
        </Space>
      }
      onCancel={onClose}
      onOk={() => onSubmit(current)}
      okText="确定选择"
      cancelText="取消"
      afterClose={() => setValue('keep-local')}
    >
      <Paragraph type="secondary" style={{ marginBottom: 8 }}>
        {item.reason}
      </Paragraph>
      {!isDelete && item.incomingRow && item.localRow ? <VersionDiff item={item} /> : <Alert type="info" showIcon message={item.reason} />}
      <Radio.Group
        style={{ marginTop: 16 }}
        value={current}
        onChange={(event) => !options.find((option) => option.value === event.target.value)?.disabled && setValue(event.target.value)}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          {options.map((option) => (
            <Radio key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
              {option.disabled ? <Tag color="red" style={{ marginLeft: 8 }}>终孔/样品事实锁定</Tag> : null}
            </Radio>
          ))}
        </Space>
      </Radio.Group>
    </Modal>
  );
}

/** 差量包导出卡片 */
function ExportPanel({ onExported }: { onExported: () => void }) {
  const { message } = AntApp.useApp();
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [target, setTarget] = useState<string>('*');
  const [busy, setBusy] = useState(false);

  const refreshPeers = async () => setPeers(await listPeers());
  useEffect(() => {
    void refreshPeers();
  }, []);

  const handleExport = async () => {
    setBusy(true);
    try {
      const targetName = peers.find((peer) => peer.id === target)?.name;
      const pkg = await buildDeltaPackage({ target: target === '*' ? undefined : target, targetName });
      downloadText(deltaFileName(pkg), JSON.stringify(pkg, null, 2));
      message.success(
        target === '*'
          ? '已导出通用全量差量包（首次对接到任意编录本使用）'
          : `已导出针对「${targetName ?? target}」的增量差量包`,
      );
      onExported();
      await refreshPeers();
    } catch (error) {
      message.error(`导出失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card size="small" title={<Space><CloudUploadOutlined />导出差量包</Space>}>
      <Paragraph type="secondary" style={{ marginBottom: 12 }}>
        包内标注记录来源设备与基线版本（各记录修订号）。选过对端后只导出自上次以来的增量，未对接过请用通用全量包。
      </Paragraph>
      <Space wrap>
        <Radio.Group value={target} onChange={(event) => setTarget(event.target.value)} optionType="button" buttonStyle="solid">
          <Radio.Button value="*">通用包（全量）</Radio.Button>
          {peers.map((peer) => (
            <Radio.Button key={peer.id} value={peer.id}>
              {peer.name}
            </Radio.Button>
          ))}
        </Radio.Group>
        <Button type="primary" icon={<CloudUploadOutlined />} loading={busy} onClick={handleExport}>
          导出差量包
        </Button>
      </Space>
    </Card>
  );
}

/** 差量包导入卡片 */
function ImportPanel({ onStaged }: { onStaged: () => void }) {
  const { message } = AntApp.useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const handleFile = async (file: File) => {
    setBusy(true);
    try {
      const text = await file.text();
      let pkg: DeltaPackage;
      try {
        pkg = parseDeltaPackage(text);
      } catch (error) {
        message.error((error as Error).message);
        return;
      }
      const staged = await stageReconciliation(pkg);
      const summary = `自动 ${staged.items.filter((item) => item.status === 'auto').length} / 待处理 ${
        staged.items.filter((item) => item.status === 'pending').length
      } / 挂起 ${staged.items.filter((item) => item.status === 'held').length}`;
      message.success(`已完成与「${pkg.source.name}」差量包的逐项对账：${summary}`);
      onStaged();
    } catch (error) {
      message.error(`对账失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <Card size="small" title={<Space><ImportOutlined />导入差量包对账</Space>}>
      <Paragraph type="secondary" style={{ marginBottom: 12 }}>
        选择对端带回的差量包文件，系统先按钻孔、回次、岩芯箱、岩性逐项对账，不会立即改动本地四张表。
      </Paragraph>
      <input
        ref={inputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleFile(file);
        }}
      />
      <Button icon={<ImportOutlined />} loading={busy} onClick={() => inputRef.current?.click()}>
        选择差量包并对账
      </Button>
    </Card>
  );
}

/** 本机设置卡片 */
function DevicePanel({ onChange }: { onChange: () => void }) {
  const { message } = AntApp.useApp();
  const [name, setName] = useState('');
  const [deviceId, setDeviceId] = useState('');

  useEffect(() => {
    void getDeviceIdentity().then((identity) => {
      setName(identity.name);
      setDeviceId(identity.id);
    });
  }, []);

  const save = async () => {
    await renameDevice(name);
    message.success('本机编录本名称已更新（设备 id 不变，后续导出的来源标注使用新名称）');
    onChange();
  };

  return (
    <Card size="small" title={<Space><SafetyCertificateTwoTone />本机来源标识</Space>}>
      <Descriptions column={1} size="small">
        <Descriptions.Item label="设备 id">{deviceId}</Descriptions.Item>
      </Descriptions>
      <Space style={{ marginTop: 8 }}>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #d9d9d9', minWidth: 240 }}
          placeholder="编录本名称，如 甲机/ZK-2401 组"
        />
        <Button onClick={save}>保存名称</Button>
      </Space>
    </Card>
  );
}

/** 差量合并中心：导出 / 导入对账 / 待处理区 / 整包应用 */
export default function MergeCenter({ onDataChanged }: { onDataChanged: () => void }) {
  const session = useMergeSession(onDataChanged);
  const { staged } = session;
  const [activeTable, setActiveTable] = useState<TableKey>('holes');
  const [resolving, setResolving] = useState<ReconcileItem | null>(null);

  const itemsByTable = useMemo(() => {
    const grouped: Record<TableKey, ReconcileItem[]> = { holes: [], runs: [], boxes: [], lithos: [] };
    for (const item of staged?.items ?? []) grouped[item.table].push(item);
    return grouped;
  }, [staged]);

  const unresolvedCount = useMemo(
    () => (staged?.items ?? []).filter((item) => (item.status === 'pending' || item.status === 'held') && !session.staged?.resolutions[item.itemId]).length,
    [staged, session.staged],
  );

  const buildColumns = (table: TableKey): TableColumnsType<ReconcileItem> => [
    {
      title: '对象',
      dataIndex: 'title',
      render: (_: unknown, item) => <Text strong>{rowTitle(table, item.localRow ?? item.incomingRow)}</Text>,
    },
    {
      title: '判定',
      dataIndex: 'status',
      width: 110,
      render: (_: unknown, item) => {
        const meta = STATUS_META[item.status];
        const icon =
          item.status === 'auto' ? (
            <CheckCircleTwoTone twoToneColor="#52c41a" />
          ) : item.status === 'held' ? (
            <PauseCircleTwoTone twoToneColor="#faad14" />
          ) : item.status === 'pending' ? (
            <SafetyCertificateTwoTone twoToneColor="#fa8c16" />
          ) : null;
        return (
          <Space size={4}>
            {icon}
            <Tag color={meta.color} style={{ marginInlineEnd: 0 }}>{meta.text}</Tag>
          </Space>
        );
      },
    },
    { title: '动作', dataIndex: 'action', width: 90, render: (action: string) => (action === 'upsert' ? '并入/更新' : action === 'delete' ? '删除' : '保留') },
    { title: '对账说明', dataIndex: 'reason', render: (reason: string) => <Text type="secondary">{reason}</Text> },
    {
      title: '来源',
      width: 150,
      render: (_: unknown, item) => {
        const incomingDevice = item.incomingRow?._origin?.deviceName ?? staged?.pkg.source.name ?? '对端';
        const localDevice = item.localRow?._origin?.deviceName ?? '本机';
        return (
          <Space size={4} direction="vertical" style={{ lineHeight: 1.2 }}>
            <Text style={{ fontSize: 12 }}>包：{incomingDevice}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>本机：{localDevice}</Text>
          </Space>
        );
      },
    },
    {
      title: '决议',
      width: 150,
      render: (_: unknown, item) => {
        const choice = staged?.resolutions[item.itemId];
        if (item.status === 'auto') return <Tag color="green">随整包自动执行</Tag>;
        if (item.status === 'ignore') return <Tag>无需处理</Tag>;
        return (
          <Space>
            <Button size="small" type={choice ? 'default' : 'primary'} onClick={() => setResolving(item)}>
              {choice ? (
                choice === 'keep-local'
                  ? '已选：保留本机'
                  : choice === 'take-incoming'
                    ? '已选：采用导入'
                    : choice === 'merge-incoming-nonprotected'
                      ? '已选：并入非保护字段'
                      : '已选：确认删除'
              ) : '选定版本'}
            </Button>
            {choice ? (
              <Button size="small" type="link" danger onClick={() => void session.unchoose(item.itemId)}>
                撤回
              </Button>
            ) : null}
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <Title level={4} style={{ marginTop: 0 }}>离线差量合并</Title>
      <Paragraph type="secondary">
        两台编录本各自录入后，用差量包回驻地合账：导出包标注来源设备与基线版本；导入先逐项对账，本机已确认的终孔与样品事实锁定保护，
        两边都改的对象进待处理区由编录员选定版本，挂起项不进入其他对象的自动合并；整包在一个事务内落库，失败保留四张旧表并可重试。
      </Paragraph>

      <Row gutter={12}>
        <Col xs={24} lg={8}><ExportPanel onExported={session.refresh} /></Col>
        <Col xs={24} lg={8}><ImportPanel onStaged={session.refresh} /></Col>
        <Col xs={24} lg={8}><DevicePanel onChange={session.refresh} /></Col>
      </Row>

      <Card style={{ marginTop: 12 }} styles={{ body: { paddingTop: 12 } }}>
        {!staged ? (
          <Empty description="尚未导入差量包。导入对账后，自动合并项与待处理项会列在这里。" />
        ) : (
          <div>
            <Row gutter={12} align="middle" justify="space-between" style={{ marginBottom: 12 }}>
              <Col>
                <Space size="large" wrap>
                  <Statistic title="对账对象" value={staged.items.length} />
                  <Statistic title="自动合并" valueStyle={{ color: '#52c41a' }} value={staged.items.filter((item) => item.status === 'auto').length} />
                  <Statistic title="待处理" valueStyle={{ color: '#fa8c16' }} value={staged.items.filter((item) => item.status === 'pending').length} />
                  <Statistic title="挂起隔离" valueStyle={{ color: '#d48806' }} value={staged.items.filter((item) => item.status === 'held').length} />
                  <Statistic title="保留本机" value={staged.items.filter((item) => item.status === 'ignore').length} />
                </Space>
              </Col>
              <Col>
                <Space>
                  <Text type="secondary">来源：{staged.pkg.source.name} · 导出于 {staged.pkg.exportedAt.slice(0, 16).replace('T', ' ')}</Text>
                  <Button onClick={() => void session.discard()}>放弃该包</Button>
                  <Button
                    type="primary"
                    loading={session.applying}
                    disabled={unresolvedCount > 0}
                    onClick={() => void session.apply()}
                  >
                    {unresolvedCount > 0 ? `还有 ${unresolvedCount} 项待选定` : '整包写入本地'}
                  </Button>
                </Space>
              </Col>
            </Row>
            {unresolvedCount > 0 ? (
              <Alert
                style={{ marginBottom: 12 }}
                type="warning"
                showIcon
                message={`待处理/挂起的 ${unresolvedCount} 项不会进入自动合并，请逐项选定版本后再整包写入；它们也不会影响其他对象的自动合并。`}
              />
            ) : (
              <Alert
                style={{ marginBottom: 12 }}
                type="success"
                showIcon
                message="待处理项均已选定，可以整包写入。写入在单个事务内完成，若有任一项校验失败会整体回滚、四张旧表原样保留，可直接重试。"
              />
            )}
            <Tabs
              activeKey={activeTable}
              onChange={(key) => setActiveTable(key as TableKey)}
              items={TABLE_TABS.map((tab) => {
                const rows = itemsByTable[tab.key];
                const unresolved = rows.filter((item) => (item.status === 'pending' || item.status === 'held') && !staged.resolutions[item.itemId]).length;
                return {
                  key: tab.key,
                  label: (
                    <span>
                      {tab.label}
                      <Tag style={{ marginInlineStart: 6 }} color={rows.length ? undefined : 'default'}>{rows.length}</Tag>
                      {unresolved > 0 ? <Tag color="orange">{unresolved} 待选</Tag> : null}
                    </span>
                  ),
                  children: (
                    <Table
                      rowKey="itemId"
                      size="small"
                      columns={buildColumns(tab.key)}
                      dataSource={rows}
                      pagination={{ pageSize: 8, showSizeChanger: false }}
                      rowClassName={(item) => (item.status === 'pending' || item.status === 'held') && !staged.resolutions[item.itemId] ? 'merge-need-decision-row' : ''}
                    />
                  ),
                };
              })}
            />
          </div>
        )}
      </Card>

      <ResolveModal
        item={resolving}
        choice={resolving ? staged?.resolutions[resolving.itemId] : undefined}
        onClose={() => setResolving(null)}
        onSubmit={async (choice) => {
          if (resolving) await session.choose(resolving.itemId, choice);
          setResolving(null);
        }}
      />
    </div>
  );
}
