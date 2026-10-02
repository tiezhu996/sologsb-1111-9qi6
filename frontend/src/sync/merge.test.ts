import { describe, expect, it } from 'vitest';
import { planMerge } from './merge';
import { legacyEnvelope } from './clock';
import type { EntityTable, SyncPackage, Tombstone, VersionVector } from './types';

type Row = Record<string, unknown>;

function envelope(nodeId: string, vv: VersionVector, baseVv: VersionVector = {}) {
  return { nodeId, vv: { ...vv }, baseVv: { ...baseVv }, updatedAt: new Date().toISOString() };
}

function row(table: EntityTable, id: string, nodeId: string, vv: VersionVector, extra: Row): Row {
  return { id, ...extra, ...envelope(nodeId, vv) };
}

function tombstoneFor(r: Row, nodeId: string, vv: VersionVector, baseVv: VersionVector = {}): Tombstone {
  return {
    id: `holes:${r.id}`,
    table: 'holes',
    entityId: String(r.id),
    ...envelope(nodeId, vv, baseVv),
  };
}

function pack(
  parts: {
    holes?: Row[];
    runs?: Row[];
    boxes?: Row[];
    lithos?: Row[];
    tombstones?: Tombstone[];
  } = {},
  nodeId = 'B',
): SyncPackage {
  return {
    app: 'gbdrillcore-sync',
    kind: 'delta',
    formatVersion: 1,
    nodeId,
    exportedAt: new Date().toISOString(),
    schemaVersion: 3,
    watermark: { A: 1, B: 1 },
    since: null,
    holes: parts.holes ?? [],
    runs: parts.runs ?? [],
    boxes: parts.boxes ?? [],
    lithos: parts.lithos ?? [],
    tombstones: parts.tombstones ?? [],
  };
}

const empty = { holes: [], runs: [], boxes: [], lithos: [], tombstones: [] as Tombstone[] };

function hole(id: string, nodeId: string, vv: VersionVector, extra: Row): Row {
  return row('holes', id, nodeId, vv, {
    holeNo: id,
    coordX: 0,
    coordY: 0,
    collarElevation: 0,
    designDepth: 100,
    finalDepth: 0,
    startDate: '2026-01-01',
    rigNo: 'XY-1',
    shift: '甲班',
    surveyData: [],
    ...extra,
  });
}

function box(id: string, nodeId: string, vv: VersionVector, extra: Row): Row {
  return row('boxes', id, nodeId, vv, {
    boxNo: id,
    holeId: 'h1',
    fromDepth: 0,
    toDepth: 25,
    slots: 10,
    slotLength: 2.5,
    boxedAt: '2026-01-01',
    shelfPos: 'A 区 1 架',
    damagedSlots: [],
    operator: '甲',
    ...extra,
  });
}

function litho(id: string, nodeId: string, vv: VersionVector, extra: Row): Row {
  return row('lithos', id, nodeId, vv, {
    holeId: 'h1',
    fromDepth: 0,
    toDepth: 10,
    lithology: '花岗闪长岩',
    color: '灰白',
    alteration: '无',
    mineralization: '无',
    rqd: 80,
    sampleNo: '',
    logger: '甲',
    ...extra,
  });
}

describe('planMerge 离线差量对账', () => {
  it('对方在同版本之后改过：自动快进（remote-update）', () => {
    const local = hole('h1', 'A', { A: 1 }, { remark: '本地版' });
    const remote = hole('h1', 'B', { A: 1, B: 1 }, { remark: '对方修改', baseVv: { A: 1 } } as Row);
    remote.baseVv = { A: 1 };
    const { ops, pending, stats } = planMerge(pack({ holes: [remote] }), { ...empty, holes: [local] });
    expect(pending).toHaveLength(0);
    expect(ops.filter((o) => o.type === 'upsert')).toHaveLength(1);
    expect(stats.remoteUpdate).toBe(1);
  });

  it('本地在同版本之后改过、对方没动：保留本地，无动作', () => {
    const local = hole('h1', 'A', { A: 1, B: 1 }, { remark: '本地新改' });
    const remote = hole('h1', 'B', { A: 1, B: 1 }, { remark: '对方旧版' });
    const { ops, pending } = planMerge(pack({ holes: [remote] }), { ...empty, holes: [local] });
    expect(pending).toHaveLength(0);
    expect(ops).toHaveLength(0);
  });

  it('两边都改过：进待处理区，不产生自动合并动作', () => {
    const local = hole('h1', 'A', { A: 2 }, { remark: '本地改' });
    const remote = hole('h1', 'B', { A: 1, B: 1 }, { remark: '对方改' });
    const { ops, pending } = planMerge(pack({ holes: [remote] }), { ...empty, holes: [local] });
    expect(ops.filter((o) => o.table === 'holes')).toHaveLength(0);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ table: 'holes', entityId: 'h1', reason: 'diverged' });
  });

  it('版本相同：计为 identical，不写不冲突', () => {
    const local = hole('h1', 'A', { A: 1 }, {});
    const remote = hole('h1', 'A', { A: 1 }, {});
    const { ops, pending, stats } = planMerge(pack({ holes: [remote] }), { ...empty, holes: [local] });
    expect(ops).toHaveLength(0);
    expect(pending).toHaveLength(0);
    expect(stats.identical).toBe(1);
  });

  it('对方新建：自动新增（remote-new）', () => {
    const remote = hole('h9', 'B', { B: 1 }, {});
    const { ops, stats } = planMerge(pack({ holes: [remote] }), empty);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: 'upsert', table: 'holes', verdict: 'remote-new' });
    expect(stats.remoteNew).toBe(1);
  });

  it('本地已确认终孔（终孔深度>0）：对方单边修改终孔事实不得覆盖，转待处理', () => {
    const local = hole('h1', 'A', { A: 1 }, { finalDepth: 120, endDate: '2026-09-01' });
    const remote = hole('h1', 'B', { A: 1, B: 1 }, { finalDepth: 150, endDate: '2026-09-02' });
    const { ops, pending } = planMerge(pack({ holes: [remote] }), { ...empty, holes: [local] });
    expect(ops.filter((o) => o.table === 'holes')).toHaveLength(0);
    expect(pending).toHaveLength(1);
    expect(pending[0].reason).toBe('protected');
    expect(pending[0].protectedFields).toEqual(expect.arrayContaining(['finalDepth', 'endDate']));
  });

  it('未终孔钻孔：对方补录终孔深度不属于覆盖已确认事实，自动快进', () => {
    const local = hole('h1', 'A', { A: 1 }, { finalDepth: 0 });
    const remote = hole('h1', 'B', { A: 1, B: 1 }, { finalDepth: 130, endDate: '2026-09-10' });
    const { ops, pending } = planMerge(pack({ holes: [remote] }), { ...empty, holes: [local] });
    expect(pending).toHaveLength(0);
    expect(ops.filter((o) => o.type === 'upsert')).toHaveLength(1);
  });

  it('本地已编样品号：对方单边清空/改样品号不得覆盖，转待处理', () => {
    const local = litho('l1', 'A', { A: 1 }, { sampleNo: 'YP-2401-01' });
    const remote = litho('l1', 'B', { A: 1, B: 1 }, { sampleNo: '' });
    const { ops, pending } = planMerge(pack({ lithos: [remote] }), { ...empty, lithos: [local] });
    expect(ops.filter((o) => o.table === 'lithos')).toHaveLength(0);
    expect(pending[0]).toMatchObject({ reason: 'protected', protectedFields: ['sampleNo'] });
  });

  it('本地无样品时对方补录样品号：自动快进', () => {
    const local = litho('l1', 'A', { A: 1 }, { sampleNo: '' });
    const remote = litho('l1', 'B', { A: 1, B: 1 }, { sampleNo: 'YP-2401-02' });
    const { ops, pending } = planMerge(pack({ lithos: [remote] }), { ...empty, lithos: [local] });
    expect(pending).toHaveLength(0);
    expect(ops.filter((o) => o.type === 'upsert')).toHaveLength(1);
  });

  it('对方删除且本地未改：删除生效并落墓碑', () => {
    const local = hole('h1', 'A', { A: 1 }, {});
    const tomb = tombstoneFor(local, 'B', { A: 1, B: 1 }, { A: 1 });
    const { ops, pending } = planMerge(pack({ tombstones: [tomb] }), { ...empty, holes: [local] });
    expect(pending).toHaveLength(0);
    expect(ops.filter((o) => o.type === 'delete')).toHaveLength(1);
  });

  it('本地已确认终孔、对方删除：删除不得抹掉事实，转待处理', () => {
    const local = hole('h1', 'A', { A: 1 }, { finalDepth: 200, endDate: '2026-08-01' });
    const tomb = tombstoneFor(local, 'B', { A: 1, B: 1 }, { A: 1 });
    const { ops, pending } = planMerge(pack({ tombstones: [tomb] }), { ...empty, holes: [local] });
    expect(ops.filter((o) => o.type === 'delete')).toHaveLength(0);
    expect(pending[0]).toMatchObject({ reason: 'protected', remoteDeleted: true });
  });

  it('一边删一边改（并发）：进待处理区，由编录员裁决删或留', () => {
    const local = hole('h1', 'A', { A: 2 }, { remark: '本地在删后又改' });
    // 本地记录 vv 为 {A:2}，对方基于 {A:1} 删除
    const tomb = tombstoneFor(local, 'B', { A: 1, B: 1 }, { A: 1 });
    const { ops, pending } = planMerge(pack({ tombstones: [tomb] }), { ...empty, holes: [local] });
    expect(ops.filter((o) => o.type === 'delete')).toHaveLength(0);
    expect(pending[0]).toMatchObject({ reason: 'remote-deleted', remoteDeleted: true });
  });

  it('待处理项不参与其他对象合并：与待处理钻孔无关的新对象仍自动合并', () => {
    const conflictLocal = hole('h1', 'A', { A: 2 }, { remark: 'x' });
    const conflictRemote = hole('h1', 'B', { A: 1, B: 1 }, { remark: 'y' });
    const other = hole('h2', 'B', { B: 1 }, {});
    const { ops, pending } = planMerge(
      pack({ holes: [conflictRemote, other] }),
      { ...empty, holes: [conflictLocal] },
    );
    expect(pending).toHaveLength(1);
    expect(pending[0].entityId).toBe('h1');
    expect(ops.filter((o) => o.entityId === 'h2')).toHaveLength(1);
  });

  it('重复箱号：自动写入会撞箱号时转待处理，不重复生成箱号', () => {
    const localBox = box('box-1', 'A', { A: 1 }, { boxNo: 'X-01' });
    // 对方新建的另一条记录用了同一箱号
    const dup = box('box-2', 'B', { B: 1 }, { boxNo: 'X-01' });
    const { ops, pending } = planMerge(pack({ boxes: [dup] }), { ...empty, boxes: [localBox] });
    expect(ops.filter((o) => o.entityId === 'box-2')).toHaveLength(0);
    expect(pending[0]).toMatchObject({ reason: 'duplicate', duplicateOf: 'box-1' });
  });

  it('对方更新已存在岩芯箱箱号改成与别的箱重复：同样转待处理', () => {
    const b1 = box('box-1', 'A', { A: 1 }, { boxNo: 'X-01' });
    const b2 = box('box-2', 'A', { A: 1 }, { boxNo: 'X-02' });
    const b2remote = box('box-2', 'B', { A: 1, B: 1 }, { boxNo: 'X-01' });
    const { ops, pending } = planMerge(pack({ boxes: [b2remote] }), { ...empty, boxes: [b1, b2] });
    expect(ops.filter((o) => o.entityId === 'box-2')).toHaveLength(0);
    expect(pending[0].reason).toBe('duplicate');
  });

  it('重复岩性区间：对方新区间与本地重叠时转待处理，不生成重叠区间', () => {
    const localLitho = litho('l1', 'A', { A: 1 }, { fromDepth: 0, toDepth: 10 });
    const dup = litho('l2', 'B', { B: 1 }, { fromDepth: 5, toDepth: 15 });
    const { ops, pending } = planMerge(pack({ lithos: [dup] }), { ...empty, lithos: [localLitho] });
    expect(ops.filter((o) => o.entityId === 'l2')).toHaveLength(0);
    expect(pending[0]).toMatchObject({ reason: 'duplicate', duplicateMessage: expect.stringContaining('重叠') });
  });

  it('不同钻孔的同深度岩性区间不算重复', () => {
    const localLitho = litho('l1', 'A', { A: 1 }, { holeId: 'h1', fromDepth: 0, toDepth: 10 });
    const other = litho('l2', 'B', { B: 1 }, { holeId: 'h2', fromDepth: 0, toDepth: 10 });
    const { ops, pending } = planMerge(pack({ lithos: [other] }), { ...empty, lithos: [localLitho] });
    expect(pending).toHaveLength(0);
    expect(ops.filter((o) => o.entityId === 'l2')).toHaveLength(1);
  });

  it('删除释放箱号：本地删除的箱号，对方新箱可自动采用', () => {
    const localBox = box('box-1', 'A', { A: 1 }, { boxNo: 'X-01' });
    const tomb = {
      id: 'boxes:box-1',
      table: 'boxes' as const,
      entityId: 'box-1',
      ...envelope('A', { A: 2 }, { A: 1 }),
    };
    const newBox = box('box-9', 'B', { B: 1 }, { boxNo: 'X-01' });
    const { ops, pending } = planMerge(
      pack({ boxes: [newBox], tombstones: [tomb] }, 'A'),
      { ...empty, boxes: [localBox] },
    );
    // 本地删除生效 + 对方新箱同箱号自动新增（删除先释放了箱号）
    expect(pending).toHaveLength(0);
    expect(ops.filter((o) => o.entityId === 'box-1' && o.type === 'delete')).toHaveLength(1);
    expect(ops.filter((o) => o.entityId === 'box-9' && o.type === 'upsert')).toHaveLength(1);
  });

  it('旧数据缺来源字段：按兼容规则回填公共祖先，两边都改过正确识别为冲突', () => {
    const legacy: Row = {
      id: 'h1',
      holeNo: 'ZK-01',
      designDepth: 100,
      finalDepth: 0,
      startDate: '2026-01-01',
      rigNo: 'XY-1',
      shift: '甲班',
      surveyData: [],
    };
    // 本地旧记录
    const local = { ...legacy, ...legacyEnvelope() };
    // 对方旧记录也回填为同一公共祖先；模拟对方随后改了一版（B@1）
    const remote = {
      ...legacy,
      remark: '对方编辑',
      ...envelope('B', { __legacy__: 1, B: 1 }, { __legacy__: 1 }),
    };
    const { ops, pending } = planMerge(pack({ holes: [remote] }), { ...empty, holes: [local] });
    // 本地仍是祖先版、对方单边改 → 自动快进
    expect(pending).toHaveLength(0);
    expect(ops.filter((o) => o.type === 'upsert')).toHaveLength(1);

    // 两边都在旧库上各自改过 → diverged
    const localEdited = { ...legacy, remark: '本地编辑', ...envelope('A', { __legacy__: 1, A: 1 }, { __legacy__: 1 }) };
    const plan2 = planMerge(pack({ holes: [remote] }), { ...empty, holes: [localEdited] });
    expect(plan2.pending[0]?.reason).toBe('diverged');
  });

  it('对账按钻孔/回次/岩芯箱/岩性四类分别给出动作', () => {
    const p = pack({
      holes: [hole('h1', 'B', { B: 1 }, {})],
      runs: [row('runs', 'r1', 'B', { B: 1 }, { runNo: 'R1', holeId: 'h1', fromDepth: 0, toDepth: 5 })],
      boxes: [box('b1', 'B', { B: 1 }, { id: 'b1' })],
      lithos: [litho('l1', 'B', { B: 1 }, { id: 'l1' })],
    });
    const { ops, stats } = planMerge(p, empty);
    expect(ops.filter((o) => o.type === 'upsert').map((o) => o.table).sort()).toEqual(['boxes', 'holes', 'lithos', 'runs']);
    expect(stats.remoteNew).toBe(4);
  });
});
