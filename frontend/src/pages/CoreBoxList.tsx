import { useMemo, useState } from 'react';
import { Alert, App as AntApp, Button, Card, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Row, Col, Select, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import BoxGrid from '../components/common/BoxGrid';
import DepthRangeInput from '../components/common/DepthRangeInput';
import EmptyPanel from '../components/common/EmptyPanel';
import { useHoleStore } from '../stores/holeStore';
import { useRunStore } from '../stores/runStore';
import { useBoxStore } from '../stores/boxStore';
import { SHELF_POSITIONS, type CoreBox, type BoxContinuity } from '../types/core-box';
import { boxCapacityOk, checkBoxContinuity, validateRange } from '../utils/recovery';

const { Title, Paragraph, Text } = Typography;

interface BoxFormValues {
  boxNo: string;
  holeId: string;
  fromDepth: number;
  toDepth: number;
  slots: number;
  slotLength: number;
  boxedAt: Dayjs;
  shelfPos: string;
  operator: string;
  damagedText?: string;
  remark?: string;
}

function parseSlots(text: string | undefined): number[] {
  if (!text) return [];
  return Array.from(
    new Set(
      text
        .split(/[,，\s]+/)
        .map((v) => Number(v))
        .filter((v) => Number.isInteger(v) && v > 0),
    ),
  ).sort((a, b) => a - b);
}

/** 岩芯箱编目与格位分配：校验深度连续性 */
export default function CoreBoxList() {
  const { message } = AntApp.useApp();
  const holes = useHoleStore((s) => s.holes);
  const currentHoleId = useHoleStore((s) => s.currentHoleId);
  const setCurrentHole = useHoleStore((s) => s.setCurrentHole);
  const runs = useRunStore((s) => s.runs);
  const boxes = useBoxStore((s) => s.boxes);
  const addBox = useBoxStore((s) => s.addBox);
  const updateBox = useBoxStore((s) => s.updateBox);
  const removeBox = useBoxStore((s) => s.removeBox);
  const toggleDamagedSlot = useBoxStore((s) => s.toggleDamagedSlot);

  const [form] = Form.useForm<BoxFormValues>();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<CoreBox | null>(null);
  const [selectedBoxId, setSelectedBoxId] = useState('');
  /** 深度区间以本地 state 为唯一数据源（Form.useWatch 在弹窗挂载前可能读不到值） */
  const [range, setRange] = useState<{ from: number; to: number }>({ from: 0, to: 0 });

  const holeOptions = holes.map((hole) => ({ label: `${hole.holeNo} · ${hole.rigNo}`, value: hole.id }));
  const activeHoleId = currentHoleId || holes[0]?.id || '';
  const holeBoxes = useMemo(() => boxes.filter((b) => b.holeId === activeHoleId), [boxes, activeHoleId]);
  const selectedBox = useMemo(
    () => holeBoxes.find((b) => b.id === selectedBoxId) ?? holeBoxes[0],
    [holeBoxes, selectedBoxId],
  );

  const continuityOf = (box: CoreBox): BoxContinuity => checkBoxContinuity(box, runs);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    const lastBox = holeBoxes.reduce<CoreBox | undefined>((acc, box) => (!acc || box.toDepth > acc.toDepth ? box : acc), undefined);
    const from = lastBox ? lastBox.toDepth : 0;
    const to = Number((from + 25).toFixed(2));
    setRange({ from, to });
    form.setFieldsValue({
      boxNo: `X-${holes.find((h) => h.id === activeHoleId)?.holeNo.replace(/^ZK-/, '') ?? '0000'}-${String(holeBoxes.length + 1).padStart(2, '0')}`,
      holeId: activeHoleId,
      fromDepth: from,
      toDepth: to,
      slots: 10,
      slotLength: 2.5,
      boxedAt: dayjs(),
      shelfPos: SHELF_POSITIONS[0],
      operator: '高振华',
      damagedText: '',
    } as unknown as BoxFormValues);
    setOpen(true);
  };

  const openEdit = (record: CoreBox) => {
    setEditing(record);
    setRange({ from: record.fromDepth, to: record.toDepth });
    form.setFieldsValue({
      boxNo: record.boxNo,
      holeId: record.holeId,
      fromDepth: record.fromDepth,
      toDepth: record.toDepth,
      slots: record.slots,
      slotLength: record.slotLength,
      boxedAt: dayjs(record.boxedAt),
      shelfPos: record.shelfPos,
      operator: record.operator,
      damagedText: record.damagedSlots.join(','),
      remark: record.remark,
    } as unknown as BoxFormValues);
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
      boxNo: values.boxNo,
      holeId: values.holeId,
      fromDepth: range.from,
      toDepth: range.to,
      slots: Number(values.slots) || 0,
      slotLength: Number(values.slotLength) || 0,
      boxedAt: values.boxedAt.toISOString(),
      shelfPos: values.shelfPos,
      operator: values.operator,
      damagedSlots: parseSlots(values.damagedText).filter((slot) => slot <= (Number(values.slots) || 0)),
      remark: values.remark,
    };
    const draft: CoreBox = { id: editing?.id ?? 'draft', ...payload };
    if (!boxCapacityOk(draft)) {
      message.error('格数 × 每格长度小于区间长度，格位容量不足');
      return;
    }
    const continuity = checkBoxContinuity(draft, runs);
    if (editing) {
      await updateBox(editing.id, payload);
      message.success(`已更新箱 ${payload.boxNo}`);
    } else {
      const created = await addBox(payload);
      setSelectedBoxId(created.id);
      message.success(`已装箱 ${payload.boxNo}`);
    }
    if (!continuity.covered) {
      message.warning(continuity.message);
    }
    setOpen(false);
  };

  const columns: TableColumnsType<CoreBox> = [
    { title: '箱号', dataIndex: 'boxNo', width: 130, render: (v: string) => <Text strong>{v}</Text> },
    { title: '深度区间(m)', width: 130, render: (_, row) => `${row.fromDepth}~${row.toDepth}` },
    { title: '格数', dataIndex: 'slots', width: 70, align: 'right' },
    { title: '每格长度(m)', dataIndex: 'slotLength', width: 110, align: 'right' },
    { title: '库架位', dataIndex: 'shelfPos', width: 110 },
    { title: '装箱日期', dataIndex: 'boxedAt', width: 110, render: (v: string) => dayjs(v).format('YYYY-MM-DD') },
    { title: '装箱人', dataIndex: 'operator', width: 90 },
    {
      title: '破损格',
      width: 100,
      render: (_, row) => (row.damagedSlots.length ? <Tag color="red">{row.damagedSlots.join(',')}</Tag> : <Tag color="green">无</Tag>),
    },
    {
      title: '深度连续性校验',
      width: 320,
      render: (_, row) => {
        const continuity = continuityOf(row);
        return continuity.covered ? (
          <Text type="success">{continuity.message}</Text>
        ) : (
          <Text type="danger">{continuity.message}</Text>
        );
      },
    },
    {
      title: '操作',
      width: 200,
      fixed: 'right',
      render: (_, record) => (
        <Space size={2}>
          <Button size="small" type="link" onClick={() => setSelectedBoxId(record.id)}>
            查看格位
          </Button>
          <Button size="small" type="link" onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm title={`确认删除岩芯箱 ${record.boxNo}？`} onConfirm={() => removeBox(record.id).then(() => message.success('已删除'))}>
            <Button size="small" type="link" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const formHoleId = Form.useWatch('holeId', form) ?? activeHoleId;

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>
        岩芯箱编目与格位分配
      </Title>
      <Paragraph type="secondary">按深度区间分配格位，装箱时校验区间与回次是否连续；断档在格位网格中以虚线标出，破损格可点击切换标记。</Paragraph>

      <Space style={{ marginBottom: 12 }} wrap>
        <span style={{ color: '#6b7a86' }}>当前钻孔</span>
        <Select style={{ width: 200 }} value={activeHoleId} onChange={setCurrentHole} options={holeOptions} placeholder="选择钻孔" />
        <Button type="primary" onClick={openCreate} disabled={!activeHoleId}>
          新建岩芯箱
        </Button>
      </Space>

      {holeBoxes.length === 0 ? (
        <EmptyPanel description="该孔暂无岩芯箱记录" actionText="新建岩芯箱" onAction={openCreate} />
      ) : (
        <Row gutter={[16, 16]}>
          <Col xs={24}>
            <Card
              size="small"
              title="格位网格（点击切换破损标记）"
              extra={
                <Select
                  style={{ width: 170 }}
                  value={selectedBox?.id}
                  onChange={setSelectedBoxId}
                  options={holeBoxes.map((box) => ({ label: `${box.boxNo}（${box.fromDepth}~${box.toDepth}m）`, value: box.id }))}
                />
              }
            >
              {selectedBox ? (
                <>
                  <BoxGrid box={selectedBox} runs={runs} onToggleDamaged={(slot) => toggleDamagedSlot(selectedBox.id, slot)} />
                  <Alert
                    style={{ marginTop: 10 }}
                    type={continuityOf(selectedBox).covered ? 'success' : 'warning'}
                    showIcon
                    message={continuityOf(selectedBox).message}
                  />
                </>
              ) : null}
            </Card>
          </Col>
          <Col xs={24}>
            <Card size="small" title="岩芯箱台账">
              <Table rowKey="id" size="small" columns={columns} dataSource={holeBoxes} pagination={{ pageSize: 6 }} scroll={{ x: 1400 }} />
            </Card>
          </Col>
        </Row>
      )}

      <Modal open={open} title={editing ? `编辑岩芯箱 · ${editing.boxNo}` : '新建岩芯箱'} onCancel={() => setOpen(false)} onOk={submit} okText="保存" cancelText="取消" width={720}>
        <Form form={form} layout="vertical">
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="boxNo" label="箱号" rules={[{ required: true, message: '请输入箱号' }]}>
              <Input style={{ width: 180 }} maxLength={24} placeholder="如：X-2401-02" />
            </Form.Item>
            <Form.Item name="holeId" label="钻孔" rules={[{ required: true, message: '请选择钻孔' }]}>
              <Select style={{ width: 200 }} options={holeOptions} />
            </Form.Item>
            <Form.Item name="shelfPos" label="库架位" rules={[{ required: true, message: '请选择库架位' }]}>
              <Select style={{ width: 150 }} options={SHELF_POSITIONS.map((v) => ({ label: v, value: v }))} />
            </Form.Item>
          </Space>

          <Form.Item label="深度区间" required>
            <DepthRangeInput
              fromDepth={range.from}
              toDepth={range.to}
              referenceRuns={runs.filter((run) => run.holeId === formHoleId)}
              maxDepth={holes.find((h) => h.id === formHoleId)?.designDepth}
              onChange={(patch) => {
                setRange((prev) => ({ ...prev, ...patch }));
                form.setFieldsValue(patch as unknown as BoxFormValues);
              }}
            />
          </Form.Item>

          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="slots" label="格数" rules={[{ required: true, message: '请输入格数' }]}>
              <InputNumber min={1} max={30} style={{ width: 140 }} placeholder="格数" />
            </Form.Item>
            <Form.Item name="slotLength" label="每格长度(m)" rules={[{ required: true, message: '请输入每格长度' }]}>
              <InputNumber min={0.5} step={0.5} style={{ width: 160 }} placeholder="每格长度" />
            </Form.Item>
            <Form.Item name="boxedAt" label="装箱日期" rules={[{ required: true, message: '请选择装箱日期' }]}>
              <DatePicker style={{ width: 170 }} />
            </Form.Item>
            <Form.Item name="operator" label="装箱人" rules={[{ required: true, message: '请输入装箱人' }]}>
              <Input style={{ width: 140 }} maxLength={16} placeholder="装箱人" />
            </Form.Item>
          </Space>

          <Form.Item name="damagedText" label="破损格序号（逗号分隔，留空表示无破损）">
            <Input placeholder="如：4,7" maxLength={40} />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={60} placeholder="岩芯缺失情况等" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
