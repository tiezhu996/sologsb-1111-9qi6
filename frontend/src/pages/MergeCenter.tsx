import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Row,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
  Upload,
  App as AntApp,
} from 'antd';
import {
  CloudUploadOutlined,
  FileSearchOutlined,
  InboxOutlined,
  RedoOutlined,
  RollbackOutlined,
  SafetyCertificateOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import type { TableColumnsType, UploadProps } from 'antd';
import { downloadText } from '../utils/export';
import { useHoleStore } from '../stores/holeStore';
import { useRunStore } from '../stores/runStore';
import { useBoxStore } from '../stores/boxStore';
import { useLithoStore } from '../stores/lithoStore';
import {
  buildSyncPackage,
  commitMerge,
  discardBackup,
  dismissPending,
  getBackupMeta,
  getNodeId,
  getNodeName,
  listPending,
  previewMerge,
  resolvePending,
  restoreFromBackup,
  setNodeName,
  type BackupMeta,
} from '../sync/syncDb';
import { FIELD_LABELS } from '../sync/clock';
import { diffFields, entitySummary, fieldLabel, REASON_LABEL, TABLE_LABEL } from '../sync/labels';
import type { MergePlan, PendingItem, SyncPackage } from '../sync/types';

const { Title, Text, Paragraph } = Typography;

interface PreviewState {
  pack: SyncPackage;
  plan: MergePlan;
  text: string;
}

export default function MergeCenter() {
  const { message, modal } = AntApp.useApp();
  const [nodeId, setNodeId] = useState('');
  const [nodeName, setNodeNameInput] = useState('');
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [pending, setPendingItems] = useState<PendingItem[]>([]);
  const [backup, setBackup] = useState<BackupMeta | undefined>();
  const [targetPeer, setTargetPeer] = useState('');
  const [resolving, setResolving] = useState<PendingItem | null>(null);
  const [resolution, setResolution] = useState<'local' | 'remote'>('local');
  const fileReaderRef = useRef<((text: string, name: string) => void) | null>(null);

  const hydrateHoles = useHoleStore((s) => s.hydrate);
  const hydrateRuns = useRunStore((s) => s.hydrate);
  const hydrateBoxes = useBoxStore((s) => s.hydrate);
  const hydrateLithos = useLithoStore((s) => s.hydrate);

  const refreshAll = useCallback(async () => {
    await Promise.all([hydrateHoles(), hydrateRuns(), hydrateBoxes(), hydrateLithos()]);
    setPendingItems(await listPending());
    setBackup(await getBackupMeta());
  }, [hydrateHoles, hydrateRuns, hydrateBoxes, hydrateLithos]);

  useEffect(() => {
    void (async () => {
      setNodeId(await getNodeId());
      setNodeNameInput(await getNodeName());
      await refreshAll();
    })();
  }, [refreshAll]);

  const handleSaveName = async () => {
    await setNodeName(nodeName);
    message.success('本机名称已保存，后续导出差量包将带上该名称');
  };

  const handleExport = async (full: boolean) => {
    const targetNodeId = full ? undefined : targetPeer.trim() || undefined;
    const pack = await buildSyncPackage({ targetNodeId, nodeName });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const suffix = full ? 'full' : `delta-${targetNodeId ?? 'peer'}`;
    downloadText(`gbdrillcore-sync-${suffix}-${stamp}.json`, JSON.stringify(pack, null, 2));
    message.success(
      full
        ? `已导出全量差量包（来源 ${nodeName || nodeId}，含 ${pack.holes.length + pack.runs.length + pack.boxes.length + pack.lithos.length} 条记录）`
        : `已导出给 ${targetNodeId ?? '对方'} 的增量差量包`,
    );
  };

  const uploadProps: UploadProps = {
    accept: '.json,application/json',
    multiple: false,
    showUploadList: false,
    beforeUpload: (file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result ?? '');
        void fileReaderRef.current?.(text, file.name);
      };
      reader.readAsText(file);
      return false;
    },
  };

  fileReaderRef.current = async (text, name) => {
    try {
      const result = await previewMerge(text);
      setPreview({ ...result, text });
      const { stats } = result.plan;
      message.info(
        `已读取 ${name}：来自 ${result.pack.nodeName || result.pack.nodeId}，新增 ${stats.remoteNew}、更新 ${stats.remoteUpdate}、删除 ${stats.localDelete}、待处理 ${stats.pending}`,
      );
    } catch (error) {
      message.error(`差量包校验失败：${(error as Error).message}`);
    }
  };

  const handleCommit = async () => {
    if (!preview) return;
    try {
      const { plan } = await commitMerge(preview.text);
      modal.success({
        title: '差量包已整包写入',
        content: `自动合并：新增 ${plan.stats.remoteNew}、更新 ${plan.stats.remoteUpdate}、删除 ${plan.stats.localDelete}；待处理 ${plan.pending.length} 项（未自动合并）`,
      });
      setPreview(null);
      await refreshAll();
    } catch (error) {
      message.error({
        content: `整包写入失败，四张旧表已保留未动，可在下方提示条重试或回滚：${(error as Error).message}`,
        duration: 8,
      });
      await refreshAll();
    }
  };

  const handleRetry = async () => {
    // 失败重试：失败状态下四张旧表未动，重新读取包文件后重放整包写入
    if (!preview) {
      message.warning('请重新选择上次的差量包文件后再重试（四张旧表仍完整保留）');
      return;
    }
    await handleCommit();
  };

  const handleRestore = async () => {
    await restoreFromBackup();
    message.success('已用四张备份表恢复到合并前数据');
    setPreview(null);
    await refreshAll();
  };

  const handleDiscardBackup = async () => {
    await discardBackup();
    message.success('已清除合并前备份');
    await refreshAll();
  };

  const openResolve = (item: PendingItem) => {
    setResolving(item);
    // 默认选择：受保护事实默认保留本地，其余默认看对象情况
    setResolution(item.reason === 'protected' || item.remoteDeleted ? 'local' : 'remote');
  };

  const handleResolve = async () => {
    if (!resolving) return;
    await resolvePending(resolving.id, resolution);
    message.success(`已按「${resolution === 'local' ? '保留本地版本' : '采用对方版本'}」落库`);
    setResolving(null);
    await refreshAll();
  };

  const handleDismiss = async (item: PendingItem) => {
    await dismissPending(item.id);
    await refreshAll();
  };

  const pendingColumns: TableColumnsType<PendingItem> = [    {
      title: '对象',
      width: 110,
      render: (_, row) => <Tag color="blue">{TABLE_LABEL[row.table]}</Tag>,
    },
    { title: '编号', width: 150, render: (_, row) => <Text code>{row.entityId}</Text> },
    {
      title: '待处理原因',
      width: 190,
      render: (_, row) => (
        <Space direction="vertical" size={4}>
          <Tag color={REASON_LABEL[row.reason]?.color}>{REASON_LABEL[row.reason]?.text ?? row.reason}</Tag>
          {row.protectedFields?.map((f) => (
            <Tag key={f} icon={<SafetyCertificateOutlined />} color="red">
              {FIELD_LABELS[f] ?? f}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: '本地版本',
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Text>{row.localDeleted ? <Tag color="default">本地已删除</Tag> : entitySummary(row.table, row.local)}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            来源：{row.localNodeId ?? '—'}
          </Text>
        </Space>
      ),
    },
    {
      title: '对方版本',
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Text>
            {row.remoteDeleted ? <Tag color="volcano">对方已删除</Tag> : entitySummary(row.table, row.remote)}
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            来源：{row.remoteNodeId ?? '—'}
          </Text>
        </Space>
      ),
    },
    {
      title: '操作',
      width: 200,
      fixed: 'right',
      render: (_, row) => (
        <Space>
          <Button size="small" type="primary" icon={<SwapOutlined />} onClick={() => openResolve(row)}>
            选定版本
          </Button>
          <Popconfirm title="仅移出待处理区，不改业务数据？" onConfirm={() => handleDismiss(row)}>
            <Button size="small" type="link">
              忽略
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const stats = preview?.plan.stats;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Title level={4} style={{ margin: 0 }}>
        离线差量合并
      </Title>

      {backup && (
        <Alert
          type={backup.status === 'failed' ? 'error' : 'warning'}
          showIcon
          icon={backup.status === 'failed' ? <RedoOutlined /> : <RollbackOutlined />}
          style={{ alignItems: 'center' }}
          message={
            backup.status === 'failed'
              ? '上次整包写入失败：四张旧表已完整保留'
              : '上次合并已成功，合并前四张旧表备份仍保留中'
          }
          description={
            <Space wrap>
              <Text type="secondary" style={{ fontSize: 12 }}>
                来源 {backup.packNodeName || backup.packNodeId} · {backup.startedAt.slice(0, 19).replace('T', ' ')}
                {backup.error ? ` · 失败原因：${backup.error}` : ''}
              </Text>
              {backup.status === 'failed' && (
                <Button size="small" type="primary" icon={<RedoOutlined />} onClick={handleRetry}>
                  重试整包写入
                </Button>
              )}
              <Button size="small" icon={<RollbackOutlined />} onClick={handleRestore}>
                回滚到四张旧表
              </Button>
              {backup.status === 'succeeded' && (
                <Popconfirm title="确认数据无误？清除后将无法回滚此次合并" onConfirm={handleDiscardBackup}>
                  <Button size="small" type="link">
                    数据无误，清除备份
                  </Button>
                </Popconfirm>
              )}
            </Space>
          }
        />
      )}

      <Tabs
        items={[
          {
            key: 'export',
            label: '导出差量包',
            children: (
              <Row gutter={16}>
                <Col xs={24} md={12}>
                  <Card title="本机来源标识" size="small">
                    <Paragraph type="secondary" style={{ fontSize: 13 }}>
                      两台野外笔记本各用一个节点标识，导出包会标注记录来源与基线版本（版本向量水位）。
                    </Paragraph>
                    <Descriptions column={1} size="small" style={{ marginBottom: 12 }}>
                      <Descriptions.Item label="节点编号（自动）">
                        <Text code>{nodeId || '…'}</Text>
                      </Descriptions.Item>
                    </Descriptions>
                    <Space.Compact style={{ width: '100%' }}>
                      <Input
                        placeholder="本机显示名，如：驻地-编录员甲的笔记本"
                        value={nodeName}
                        onChange={(e) => setNodeNameInput(e.target.value)}
                      />
                      <Button type="primary" onClick={handleSaveName}>
                        保存名称
                      </Button>
                    </Space.Compact>
                  </Card>
                </Col>
                <Col xs={24} md={12}>
                  <Card title="导出" size="small">
                    <Space direction="vertical" style={{ width: '100%' }} size={12}>
                      <Button block size="large" icon={<CloudUploadOutlined />} onClick={() => handleExport(true)}>
                        导出全量差量包（首次交换用）
                      </Button>
                      <Card size="small" style={{ background: '#f7f9fb' }}>
                        <Text strong style={{ fontSize: 13 }}>
                          增量差量包
                        </Text>
                        <Paragraph type="secondary" style={{ fontSize: 12, margin: '4px 0 8px' }}>
                          填对方节点编号后只带上次导出以来改过的记录与删除标记；不知道编号就导全量。
                        </Paragraph>
                        <Space.Compact style={{ width: '100%' }}>
                          <Input placeholder="对方节点编号，如 dev-a1b2c3" value={targetPeer} onChange={(e) => setTargetPeer(e.target.value)} />
                          <Button icon={<FileSearchOutlined />} onClick={() => handleExport(false)}>
                            导出增量包
                          </Button>
                        </Space.Compact>
                      </Card>
                    </Space>
                  </Card>
                </Col>
              </Row>
            ),
          },
          {
            key: 'import',
            label: (
              <span>
                <InboxOutlined /> 导入对账
              </span>
            ),
            children: (
              <Space direction="vertical" size={16} style={{ width: '100%' }}>
                <Upload.Dragger {...uploadProps} style={{ padding: 12 }}>
                  <p className="ant-upload-drag-icon">
                    <InboxOutlined />
                  </p>
                  <p className="ant-upload-text">把对方的差量包文件拖到这里，或点击选择</p>
                  <p className="ant-upload-hint">导入只先逐项对账（钻孔 → 回次 → 岩芯箱 → 岩性），确认后才整包写入</p>
                </Upload.Dragger>

                {preview && stats && (
                  <Card
                    size="small"
                    title={`对账预览 · 来源：${preview.pack.nodeName || preview.pack.nodeId}`}
                    extra={
                      <Space>
                        <Button onClick={() => setPreview(null)}>取消</Button>
                        <Popconfirm
                          title="确认整包写入？"
                          description="写入前会先备份四张旧表；失败可整体重试或回滚"
                          onConfirm={handleCommit}
                        >
                          <Button type="primary">确认整包写入</Button>
                        </Popconfirm>
                      </Space>
                    }
                  >
                    <Row gutter={16}>
                      <Col span={4}>
                        <Statistic title="包内对象" value={stats.incoming} />
                      </Col>
                      <Col span={4}>
                        <Statistic title="版本相同" value={stats.identical} />
                      </Col>
                      <Col span={4}>
                        <Statistic title="自动新增" value={stats.remoteNew} valueStyle={{ color: '#3f8600' }} />
                      </Col>
                      <Col span={4}>
                        <Statistic title="自动更新" value={stats.remoteUpdate} valueStyle={{ color: '#3f8600' }} />
                      </Col>
                      <Col span={4}>
                        <Statistic title="删除生效" value={stats.localDelete} />
                      </Col>
                      <Col span={4}>
                        <Statistic title="待处理" value={stats.pending} valueStyle={{ color: stats.pending ? '#d46b08' : undefined }} />
                      </Col>
                    </Row>
                    {preview.plan.pending.length > 0 && (
                      <Alert
                        style={{ marginTop: 12 }}
                        type="warning"
                        showIcon
                        message={`${preview.plan.pending.length} 项两边都改过 / 命中受保护事实 / 会生成重复箱号或岩性区间，将保留在待处理区由编录员选定版本，不进入其他对象的自动合并`}
                      />
                    )}
                    {preview.plan.missingBaseline.length > 0 && (
                      <Alert
                        style={{ marginTop: 12 }}
                        type="info"
                        showIcon
                        message={`${preview.plan.missingBaseline.length} 个对象的基线版本本库未见过（双方可能不是从同一份库分别录），请在待处理区重点核对`}
                      />
                    )}
                  </Card>
                )}
              </Space>
            ),
          },
          {
            key: 'pending',
            label: (
              <span>
                待处理区 {pending.length > 0 && <Tag color="orange">{pending.length}</Tag>}
              </span>
            ),
            children: pending.length === 0 ? (
              <Empty description="没有待处理项：没有两边都改过的对象，也没有受保护事实冲突或重复箱号/岩性区间" />
            ) : (
              <>
                <Alert
                  type="info"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message="待处理项未参与自动合并，也不会影响其他对象；请逐项选定本地或对方版本后落库"
                />
                <Table<PendingItem>
                  rowKey="id"
                  size="small"
                  columns={pendingColumns}
                  dataSource={pending}
                  scroll={{ x: 1100 }}
                  pagination={false}
                />
              </>
            ),
          },
        ]}
      />

      <Modal
        open={Boolean(resolving)}
        title={resolving ? `选定版本：${TABLE_LABEL[resolving.table]} ${resolving.entityId}` : ''}
        onCancel={() => setResolving(null)}
        onOk={handleResolve}
        okText="确认选定并落库"
        cancelText="再看看"
        width={760}
      >
        {resolving && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Space wrap>
              <Tag color={REASON_LABEL[resolving.reason]?.color}>{REASON_LABEL[resolving.reason]?.text}</Tag>
              {resolving.duplicateMessage && <Text type="warning">{resolving.duplicateMessage}</Text>}
              {resolving.protectedFields?.map((f) => (
                <Tag key={f} color="red" icon={<SafetyCertificateOutlined />}>
                  受保护：{FIELD_LABELS[f] ?? f}
                </Tag>
              ))}
            </Space>
            <Radio.Group value={resolution} onChange={(e) => setResolution(e.target.value)}>
              <Space direction="vertical">
                <Radio value="local">
                  保留本地版本（{resolving.localDeleted ? '维持本地删除' : entitySummary(resolving.table, resolving.local)}）
                </Radio>
                <Radio value="remote">
                  采用对方版本（{resolving.remoteDeleted ? '对方已删除，即执行删除' : entitySummary(resolving.table, resolving.remote)}）
                </Radio>
              </Space>
            </Radio.Group>
            {!resolving.remoteDeleted && !resolving.localDeleted && (
              <Card size="small" title="差异字段" style={{ background: '#fafafa' }}>
                {diffFields(resolving.local, resolving.remote).length === 0 ? (
                  <Text type="secondary">业务字段无差异（仅版本不同）</Text>
                ) : (
                  <Table
                    size="small"
                    rowKey={(row) => String(row)}
                    pagination={false}
                    dataSource={diffFields(resolving.local, resolving.remote)}
                    columns={[
                      { title: '字段', width: 130, render: (f: string) => fieldLabel(f) },
                      {
                        title: '本地',
                        render: (f: string) => (
                          <Text type={resolving.reason === 'protected' && resolving.protectedFields?.includes(f) ? 'danger' : undefined}>
                            {formatValue(resolving.local?.[f])}
                          </Text>
                        ),
                      },
                      {
                        title: '对方',
                        render: (f: string) => <Text>{formatValue(resolving.remote?.[f])}</Text>,
                      },
                    ]}
                  />
                )}
              </Card>
            )}
            {resolving.reason === 'protected' && (
              <Alert
                type="warning"
                showIcon
                message="本地已确认的终孔深度/终孔日期或样品号不会被自动覆盖；如确实要采用对方，请在此显式选定「采用对方版本」"
              />
            )}
          </Space>
        )}
      </Modal>
    </Space>
  );
}

function formatValue(v: unknown): string {
  if (v === undefined || v === null || v === '') return '—';
  if (Array.isArray(v)) return v.length ? v.join('、') : '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
