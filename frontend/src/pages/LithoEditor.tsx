import { useMemo, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Col, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import DepthRangeInput from '../components/common/DepthRangeInput';
import LithoColumn from '../components/common/LithoColumn';
import EmptyPanel from '../components/common/EmptyPanel';
import { useHoleStore } from '../stores/holeStore';
import { useRunStore } from '../stores/runStore';
import { useLithoStore } from '../stores/lithoStore';
import {
  ALTERATIONS,
  LITHOLOGIES,
  MINERALIZATIONS,
  type Alteration,
  type LithoLog,
  type Lithology,
  type Mineralization,
} from '../types/litho-log';
import { gapsWithin, validateRange } from '../utils/recovery';

const { Title, Paragraph, Text } = Typography;

interface LithoFormValues {
  holeId: string;
  fromDepth: number;
  toDepth: number;
  lithology: Lithology;
  color: string;
  alteration: Alteration;
  mineralization: Mineralization;
  rqd: number;
  sampleNo: string;
  logger: string;
  remark?: string;
}

/** 岩性描述编录：按深度区间校重叠 + SVG 柱状图 */
export default function LithoEditor() {
  const { message } = AntApp.useApp();
  const holes = useHoleStore((s) => s.holes);
  const currentHoleId = useHoleStore((s) => s.currentHoleId);
  const setCurrentHole = useHoleStore((s) => s.setCurrentHole);
  const runs = useRunStore((s) => s.runs);
  const lithos = useLithoStore((s) => s.lithos);
  const addLitho = useLithoStore((s) => s.addLitho);
  const updateLitho = useLithoStore((s) => s.updateLitho);
  const removeLitho = useLithoStore((s) => s.removeLitho);
  const checkConflicts = useLithoStore((s) => s.checkConflicts);

  const [form] = Form.useForm<LithoFormValues>();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<LithoLog | null>(null);
  const [conflictIds, setConflictIds] = useState<string[]>([]);
  /** 深度区间以本地 state 为唯一数据源（Form.useWatch 在弹窗挂载前可能读不到值） */
  const [range, setRange] = useState<{ from: number; to: number }>({ from: 0, to: 0 });

  const holeOptions = holes.map((hole) => ({ label: `${hole.holeNo} · 设计 ${hole.designDepth}m`, value: hole.id }));
  const activeHoleId = currentHoleId || holes[0]?.id || '';
  const holeLogs = useMemo(
    () => lithos.filter((log) => log.holeId === activeHoleId).sort((a, b) => a.fromDepth - b.fromDepth),
    [lithos, activeHoleId],
  );
  const holeRuns = useMemo(() => runs.filter((run) => run.holeId === activeHoleId), [runs, activeHoleId]);
  const activeHole = holes.find((h) => h.id === activeHoleId);

  const liveFrom = range.from;
  const liveTo = range.to;
  const liveHoleId = Form.useWatch('holeId', form) ?? activeHoleId;
  const liveConflicts = useMemo(() => {
    if (!liveTo || liveTo <= liveFrom) return [];
    return checkConflicts({ holeId: liveHoleId, fromDepth: liveFrom, toDepth: liveTo }, editing?.id);
  }, [checkConflicts, liveHoleId, liveFrom, liveTo, editing?.id]);

  const gaps = useMemo(() => (liveTo > liveFrom ? gapsWithin(liveFrom, liveTo, runs.filter((r) => r.holeId === liveHoleId)) : []), [runs, liveHoleId, liveFrom, liveTo]);

  const coverageRatio = useMemo(() => {
    if (!activeHole || activeHole.designDepth <= 0) return 0;
    const covered = holeLogs.reduce((sum, log) => sum + (log.toDepth - log.fromDepth), 0);
    return Number(((covered / activeHole.designDepth) * 100).toFixed(1));
  }, [holeLogs, activeHole]);

  const openCreate = () => {
    setEditing(null);
    setConflictIds([]);
    form.resetFields();
    const lastTo = holeLogs.reduce((max, log) => Math.max(max, log.toDepth), 0);
    setRange({ from: Number(lastTo.toFixed(2)), to: Number((lastTo + 20).toFixed(2)) });
    form.setFieldsValue({
      holeId: activeHoleId,
      fromDepth: Number(lastTo.toFixed(2)),
      toDepth: Number((lastTo + 20).toFixed(2)),
      lithology: '花岗闪长岩',
      color: '灰白色',
      alteration: '无',
      mineralization: '无',
      rqd: 80,
      sampleNo: '',
      logger: '陈立',
    } as unknown as LithoFormValues);
    setOpen(true);
  };

  const openEdit = (record: LithoLog) => {
    setEditing(record);
    setConflictIds([]);
    setRange({ from: record.fromDepth, to: record.toDepth });
    form.setFieldsValue({
      holeId: record.holeId,
      fromDepth: record.fromDepth,
      toDepth: record.toDepth,
      lithology: record.lithology,
      color: record.color,
      alteration: record.alteration,
      mineralization: record.mineralization,
      rqd: record.rqd,
      sampleNo: record.sampleNo,
      logger: record.logger,
      remark: record.remark,
    } as unknown as LithoFormValues);
    setOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    const rangeError = validateRange(range.from, range.to);
    if (rangeError) {
      message.error(rangeError);
      return;
    }
    const payload = {
      holeId: values.holeId,
      fromDepth: range.from,
      toDepth: range.to,
      lithology: values.lithology,
      color: values.color,
      alteration: values.alteration,
      mineralization: values.mineralization,
      rqd: Number(values.rqd) || 0,
      sampleNo: values.sampleNo,
      logger: values.logger,
      remark: values.remark,
    };
    const result = editing ? await updateLitho(editing.id, payload) : await addLitho(payload);
    if (result.conflicts.length) {
      setConflictIds(result.conflicts.map((c) => c.other.id));
      const detail = result.conflicts
        .map((c) => `${c.other.fromDepth}~${c.other.toDepth}m（${c.other.lithology}）重叠 ${c.overlapFrom}~${c.overlapTo}m`)
        .join('；');
      message.error(`深度区间与已编录区间重叠：${detail}`);
      return;
    }
    setConflictIds([]);
    message.success(
      editing
        ? `已更新岩性区间 ${payload.fromDepth}~${payload.toDepth}m`
        : `已编录 ${payload.lithology} ${payload.fromDepth}~${payload.toDepth}m`,
    );
    setOpen(false);
  };

  const columns: TableColumnsType<LithoLog> = [
    { title: '深度区间(m)', width: 130, render: (_, row) => <Text strong>{`${row.fromDepth}~${row.toDepth}`}</Text> },
    { title: '厚度(m)', width: 90, align: 'right', render: (_, row) => Number((row.toDepth - row.fromDepth).toFixed(2)) },
    { title: '岩性', dataIndex: 'lithology', width: 130, render: (v: string) => <Tag color="geekblue">{v}</Tag> },
    { title: '颜色', dataIndex: 'color', width: 90 },
    { title: '蚀变', dataIndex: 'alteration', width: 110 },
    { title: '矿化', dataIndex: 'mineralization', width: 100 },
    { title: 'RQD(%)', dataIndex: 'rqd', width: 90, align: 'right', render: (v: number) => <Text type={v < 50 ? 'danger' : undefined}>{v}</Text> },
    { title: '样品号', dataIndex: 'sampleNo', width: 130, render: (v: string) => v || '-' },
    { title: '编录人', dataIndex: 'logger', width: 90 },
    { title: '备注', dataIndex: 'remark', ellipsis: true, render: (v?: string) => v ?? '-' },
    {
      title: '操作',
      width: 140,
      fixed: 'right',
      render: (_, record) => (
        <Space size={2}>
          <Button size="small" type="link" onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm title={`确认删除 ${record.fromDepth}~${record.toDepth}m 编录？`} onConfirm={() => removeLitho(record.id).then(() => message.success('已删除'))}>
            <Button size="small" type="link" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>
        岩性描述编录
      </Title>
      <Paragraph type="secondary">
        按深度区间编录岩性、蚀变、矿化与 RQD，区间不允许与已编录区间重叠（重叠即报冲突并高亮）；右侧柱状图叠加样品位与采取率异常段。
      </Paragraph>

      <Space style={{ marginBottom: 12 }} wrap>
        <span style={{ color: '#6b7a86' }}>当前钻孔</span>
        <Select style={{ width: 220 }} value={activeHoleId} onChange={setCurrentHole} options={holeOptions} placeholder="选择钻孔" />
        <Button type="primary" onClick={openCreate} disabled={!activeHoleId}>
          新增岩性区间
        </Button>
        <Tag color="blue">已编录 {holeLogs.length} 段</Tag>
        <Tag color={coverageRatio >= 80 ? 'green' : 'orange'}>设计孔深覆盖率 {coverageRatio}%</Tag>
        <Tag color="red">冲突高亮 {conflictIds.length} 段</Tag>
      </Space>

      {holeLogs.length === 0 ? (
        <EmptyPanel description="该孔暂无岩性编录" actionText="新增岩性区间" onAction={openCreate} />
      ) : (
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={16}>
            <Card size="small" title="岩性编录台账">
              {conflictIds.length > 0 ? (
                <Alert
                  style={{ marginBottom: 10 }}
                  type="error"
                  showIcon
                  message={`存在 ${conflictIds.length} 段深度区间冲突（已在表格中高亮）`}
                  description="请调整起止深度，避免与已编录区间重叠。"
                />
              ) : null}
              <Table
                rowKey="id"
                size="small"
                columns={columns}
                dataSource={holeLogs}
                pagination={{ pageSize: 8 }}
                scroll={{ x: 1250 }}
                rowClassName={(row) => (conflictIds.includes(row.id) ? 'conflict-row' : '')}
              />
            </Card>
          </Col>
          <Col xs={24} lg={8}>
            <LithoColumn logs={holeLogs} runs={holeRuns} maxDepth={activeHole?.designDepth} />
          </Col>
        </Row>
      )}

      <Modal open={open} title={editing ? `编辑岩性区间 · ${editing.fromDepth}~${editing.toDepth}m` : '新增岩性区间'} onCancel={() => setOpen(false)} onOk={submit} okText="保存" cancelText="取消" width={720}>
        <Form
          form={form}
          layout="vertical"
          onValuesChange={() => {
            if (conflictIds.length) setConflictIds([]);
          }}
        >
          <Form.Item name="holeId" label="钻孔" rules={[{ required: true, message: '请选择钻孔' }]}>
            <Select style={{ width: 240 }} options={holeOptions} />
          </Form.Item>
          <Form.Item label="深度区间" required>
            <DepthRangeInput
              fromDepth={liveFrom}
              toDepth={liveTo}
              referenceRuns={runs.filter((run) => run.holeId === liveHoleId)}
              maxDepth={holes.find((h) => h.id === liveHoleId)?.designDepth}
              onChange={(patch) => {
                setRange((prev) => ({ ...prev, ...patch }));
                form.setFieldsValue(patch as unknown as LithoFormValues);
              }}
            />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="lithology" label="岩性" rules={[{ required: true, message: '请选择岩性' }]}>
              <Select style={{ width: 170 }} options={LITHOLOGIES.map((v) => ({ label: v, value: v }))} />
            </Form.Item>
            <Form.Item name="color" label="颜色" rules={[{ required: true, message: '请输入颜色' }]}>
              <Input style={{ width: 150 }} maxLength={16} placeholder="如：灰白色" />
            </Form.Item>
            <Form.Item name="alteration" label="蚀变" rules={[{ required: true, message: '请选择蚀变' }]}>
              <Select style={{ width: 150 }} options={ALTERATIONS.map((v) => ({ label: v, value: v }))} />
            </Form.Item>
            <Form.Item name="mineralization" label="矿化" rules={[{ required: true, message: '请选择矿化' }]}>
              <Select style={{ width: 140 }} options={MINERALIZATIONS.map((v) => ({ label: v, value: v }))} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="rqd" label="RQD(%)" rules={[{ required: true, message: '请输入 RQD' }]}>
              <InputNumber min={0} max={100} style={{ width: 140 }} placeholder="RQD" />
            </Form.Item>
            <Form.Item name="sampleNo" label="样品号">
              <Input style={{ width: 180 }} maxLength={24} placeholder="如：YP-2406-01" />
            </Form.Item>
            <Form.Item name="logger" label="编录人" rules={[{ required: true, message: '请输入编录人' }]}>
              <Input style={{ width: 140 }} maxLength={16} placeholder="编录人" />
            </Form.Item>
          </Space>

          {liveConflicts.length > 0 ? (
            <Alert
              type="error"
              showIcon
              message="深度区间与已编录区间重叠，无法保存"
              description={
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {liveConflicts.map((conflict) => (
                    <li key={conflict.other.id}>
                      {conflict.other.fromDepth}~{conflict.other.toDepth}m · {conflict.other.lithology} · 重叠 {conflict.overlapFrom}~{conflict.overlapTo}m
                    </li>
                  ))}
                </ul>
              }
            />
          ) : gaps.length > 0 ? (
            <Alert type="warning" showIcon message={`该区间内有 ${gaps.length} 段无对应回次（${gaps.map((g) => `${g.from}~${g.to}m`).join('、')}），请确认岩芯来源`} />
          ) : (
            <Alert type="success" showIcon message="深度区间校验通过，与既有编录无重叠" />
          )}

          <Form.Item name="remark" label="备注" style={{ marginTop: 12 }}>
            <Input.TextArea rows={2} maxLength={60} placeholder="矿化特征等" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
