/**
 * 对账引擎单测（离线可跑，不依赖浏览器/IndexedDB）：
 *   npx esbuild scripts/merge-engine.test.ts --bundle --platform=node --format=esm --outfile=/tmp/mt.mjs && node /tmp/mt.mjs
 */
import assert from 'node:assert/strict';
import { reconcile, holeConfirmed } from '../src/utils/merge';
import type { ReconcileItem, ItemStatus } from '../src/utils/merge';
import { contentRev, ensureOrigin, type DeviceIdentity, type SourcedRow } from '../src/utils/provenance';
import {
  ANY_PEER,
  emptyChangeSet,
  type BaselineSnapshot,
  type ChangeSet,
  type DeltaPackage,
} from '../src/utils/deltaPackage';

const A: DeviceIdentity = { id: 'dev-A', name: '甲机', createdAt: '2026-09-01T00:00:00.000Z' };
const B: DeviceIdentity = { id: 'dev-B', name: '乙机', createdAt: '2026-09-01T00:00:00.000Z' };

let seq = 0;
function origin(device: DeviceIdentity, at: string) {
  return { deviceId: device.id, deviceName: device.name, createdAt: at, updatedAt: at, rev: '' };
}
function row<T extends SourcedRow>(data: T, device: DeviceIdentity = A, at = '2026-09-10T00:00:00.000Z'): T {
  const r = { ...data, _origin: origin(device, at) };
  r._origin.rev = contentRev(r);
  return r;
}
/** 在某行基础上改动（修订号随之变化） */
function edit<T extends SourcedRow>(prev: T, patch: Partial<T>, device: DeviceIdentity, at: string): T {
  const next = { ...prev, ...patch, _origin: { ...prev._origin!, updatedAt: at, rev: '' } };
  next._origin.rev = contentRev(next);
  void device;
  return next;
}

const holeBase = (id: string, overrides: Record<string, unknown> = {}): SourcedRow =>
  ({
    id,
    holeNo: id,
    coordX: 1,
    coordY: 2,
    collarElevation: 100,
    designDepth: 200,
    finalDepth: 0,
    startDate: '2026-09-01',
    rigNo: 'XY-1',
    shift: '甲班',
    surveyData: [],
    ...overrides,
  }) as SourcedRow;

const runBase = (id: string, holeId: string, runNo: string, from: number, to: number): SourcedRow =>
  ({
    id,
    runNo,
    holeId,
    fromDepth: from,
    toDepth: to,
    footage: to - from,
    coreLength: to - from,
    recovery: 100,
    waterLevel: 0,
    shift: '甲班',
    drilledAt: '2026-09-05',
    recorder: '张三',
  }) as SourcedRow;

const boxBase = (id: string, holeId: string, boxNo: string, from: number, to: number): SourcedRow =>
  ({
    id,
    boxNo,
    holeId,
    fromDepth: from,
    toDepth: to,
    slots: 10,
    slotLength: (to - from) / 10,
    boxedAt: '2026-09-06',
    shelfPos: 'A 区 1 架',
    damagedSlots: [],
    operator: '李四',
  }) as SourcedRow;

const lithoBase = (id: string, holeId: string, from: number, to: number, sampleNo = ''): SourcedRow =>
  ({
    id,
    holeId,
    fromDepth: from,
    toDepth: to,
    lithology: '花岗闪长岩',
    color: '灰白',
    alteration: '无',
    mineralization: '无',
    rqd: 80,
    sampleNo,
    logger: '王五',
  }) as SourcedRow;

function snapshotOf(items: SourcedRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of items) out[item.id] = item._origin!.rev;
  return out;
}

function makePkg(opts: {
  upserts?: Partial<Record<keyof ChangeSet, SourcedRow[]>>;
  deletes?: Partial<Record<keyof ChangeSet, string[]>>;
  baseline?: BaselineSnapshot;
  target?: string;
}): DeltaPackage {
  const changes = emptyChangeSet();
  for (const key of ['holes', 'runs', 'boxes', 'lithos'] as const) {
    if (opts.upserts?.[key]) changes[key].upserts = opts.upserts![key]!;
    if (opts.deletes?.[key]) changes[key].deletes = opts.deletes![key]!.map((id) => ({ id }));
  }
  return {
    app: 'gbdrillcore',
    kind: 'gbdrillcore-delta',
    formatVersion: 1,
    schemaVersion: 3,
    source: { id: B.id, name: B.name },
    target: opts.target ?? 'dev-A',
    exportedAt: '2026-09-20T00:00:00.000Z',
    baseline: opts.baseline ?? { holes: {}, runs: {}, boxes: {}, lithos: {} },
    changes,
  };
}

function runCase(name: string, fn: () => void) {
  seq += 1;
  try {
    fn();
    console.log(`  ok ${seq} - ${name}`);
  } catch (error) {
    console.error(`  FAIL ${seq} - ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

function find(items: ReconcileItem[], table: string, id: string): ReconcileItem {
  const item = items.find((entry) => entry.table === table && entry.incomingId === id);
  assert.ok(item, `缺少对账单 ${table}:${id}`);
  return item!;
}
function expectStatus(item: ReconcileItem, status: ItemStatus, action?: ReconcileItem['action']) {
  assert.equal(item.status, status, `状态应为 ${status}，实际 ${item.status}（${item.reason}）`);
  if (action) assert.equal(item.action, action);
}

const emptyCursor: BaselineSnapshot = { holes: {}, runs: {}, boxes: {}, lithos: {} };

console.log('钻孔：');
runCase('只有对端改钻孔 → 自动并入', () => {
  const base = row(holeBase('h1'));
  const local = [base];
  const incoming = edit(base, { coordX: 999 }, B, '2026-09-15');
  const pkg = makePkg({
    upserts: { holes: [incoming] },
    baseline: { ...emptyCursor, holes: snapshotOf([base]) },
  });
  const r = reconcile(pkg, { holes: local, runs: [], boxes: [], lithos: [] }, emptyCursor);
  expectStatus(find(r.items, 'holes', 'h1'), 'auto', 'upsert');
});

runCase('只有本机改钻孔 → 保留本机（ignore）', () => {
  const base = row(holeBase('h1'));
  const local = [edit(base, { coordX: 111 }, A, '2026-09-12')];
  const incoming = edit(base, { coordX: 999 }, B, '2026-09-15');
  // 包基线只有 base；本机游标补充说明本机也基于 base
  const cursor: BaselineSnapshot = { ...emptyCursor, holes: snapshotOf([base]) };
  const pkg = makePkg({ upserts: { holes: [incoming] }, baseline: cursor });
  const r = reconcile(pkg, { holes: local, runs: [], boxes: [], lithos: [] }, cursor);
  // 对端相对 base 改了，但本机也改了 → 实际两边都改 → pending；要构造"只本机改"，incoming 应等于 base
  const pkg2 = makePkg({ upserts: { holes: [base] }, baseline: cursor });
  const r2 = reconcile(pkg2, { holes: local, runs: [], boxes: [], lithos: [] }, cursor);
  expectStatus(find(r2.items, 'holes', 'h1'), 'ignore', 'keep');
  // 上面第一种确实两边都改
  assert.equal(find(r.items, 'holes', 'h1').status, 'pending');
});

runCase('两边都改同一钻孔 → 待处理', () => {
  const base = row(holeBase('h1'));
  const local = [edit(base, { coordX: 111 }, A, '2026-09-12')];
  const incoming = edit(base, { coordY: 222 }, B, '2026-09-15');
  const baseline = { ...emptyCursor, holes: snapshotOf([base]) };
  const pkg = makePkg({ upserts: { holes: [incoming] }, baseline });
  const r = reconcile(pkg, { holes: local, runs: [], boxes: [], lithos: [] }, emptyCursor);
  const item = find(r.items, 'holes', 'h1');
  expectStatus(item, 'pending');
  assert.ok(item.changedFields?.includes('坐标 X'));
  assert.ok(item.changedFields?.includes('坐标 Y'));
});

runCase('本机已终孔，对端改终孔深度 → 待处理且受保护', () => {
  const base = row(holeBase('h1'));
  const local = [edit(base, { finalDepth: 200, endDate: '2026-09-18' }, A, '2026-09-18')];
  const incoming = edit(base, { finalDepth: 180, endDate: '2026-09-19', rigNo: 'XY-2' }, B, '2026-09-19');
  assert.ok(holeConfirmed(local[0]));
  // 对端基于一个"本机已终孔"的状态再改：基线应包含 local 的 rev（对端同步过终孔事实）
  const synced = local[0];
  const baseline = { ...emptyCursor, holes: snapshotOf([synced]) };
  const pkg = makePkg({ upserts: { holes: [incoming] }, baseline });
  const r = reconcile(pkg, { holes: local, runs: [], boxes: [], lithos: [] }, emptyCursor);
  const item = find(r.items, 'holes', 'h1');
  expectStatus(item, 'pending');
  assert.ok(item.hardProtected);
  assert.deepEqual(item.protectedFields, ['终孔深度', '终孔日期']);
});

runCase('同孔号不同 id（两台分开录）且无基线 → 待处理', () => {
  const local = [row(holeBase('h-local', { holeNo: 'ZK-1' }))];
  const incoming = row(holeBase('h-peer', { holeNo: 'ZK-1', coordX: 500 }), B);
  const pkg = makePkg({ upserts: { holes: [incoming] } });
  const r = reconcile(pkg, { holes: local, runs: [], boxes: [], lithos: [] }, emptyCursor);
  const item = find(r.items, 'holes', 'h-peer');
  expectStatus(item, 'pending');
  assert.equal(item.targetId, 'h-local');
});

runCase('对端删孔但本机已终孔 → 待处理，终孔受保护', () => {
  const local = [row(holeBase('h1', { finalDepth: 200, endDate: '2026-09-18' }))];
  const pkg = makePkg({ deletes: { holes: ['h1'] } });
  const r = reconcile(pkg, { holes: local, runs: [], boxes: [], lithos: [] }, emptyCursor);
  const item = find(r.items, 'holes', 'h1');
  expectStatus(item, 'pending');
  assert.ok(item.hardProtected);
});

runCase('对端整孔删除且孔下子记录同包删除 → 自动', () => {
  const hole = row(holeBase('h1'));
  const run = row(runBase('r1', 'h1', 'R-1', 0, 5));
  const baseline: BaselineSnapshot = {
    ...emptyCursor,
    holes: snapshotOf([hole]),
    runs: snapshotOf([run]),
  };
  const pkg = makePkg({ deletes: { holes: ['h1'], runs: ['r1'] }, baseline });
  const r = reconcile(pkg, { holes: [hole], runs: [run], boxes: [], lithos: [] }, emptyCursor);
  expectStatus(find(r.items, 'holes', 'h1'), 'auto', 'delete');
  expectStatus(find(r.items, 'runs', 'r1'), 'auto', 'delete');
});

runCase('对端删孔但子记录没同包删 → 待处理（防孤儿）', () => {
  const hole = row(holeBase('h1'));
  const run = row(runBase('r1', 'h1', 'R-1', 0, 5));
  const pkg = makePkg({ deletes: { holes: ['h1'] } });
  const r = reconcile(pkg, { holes: [hole], runs: [run], boxes: [], lithos: [] }, emptyCursor);
  expectStatus(find(r.items, 'holes', 'h1'), 'pending');
});

console.log('回次：');
runCase('新回次自动并入', () => {
  const hole = row(holeBase('h1'));
  const run = row(runBase('r1', 'h1', 'R-1', 0, 5), B);
  const pkg = makePkg({ upserts: { runs: [run] } });
  const r = reconcile(pkg, { holes: [hole], runs: [], boxes: [], lithos: [] }, emptyCursor);
  expectStatus(find(r.items, 'runs', 'r1'), 'auto', 'upsert');
});

runCase('钻孔待处理时其下回次挂起隔离', () => {
  const localHole = row(holeBase('h-local', { holeNo: 'ZK-9' }));
  const peerHole = row(holeBase('h-peer', { holeNo: 'ZK-9', coordX: 8 }), B);
  const run = row(runBase('rr1', 'h-peer', 'R-1', 0, 5), B);
  const pkg = makePkg({ upserts: { holes: [peerHole], runs: [run] } });
  const r = reconcile(pkg, { holes: [localHole], runs: [], boxes: [], lithos: [] }, emptyCursor);
  expectStatus(find(r.items, 'runs', 'rr1'), 'held');
});

runCase('同孔深度段重复回次（自然键防重复） → 待处理', () => {
  const hole = row(holeBase('h1'));
  const local = [row(runBase('r-local', 'h1', 'R-9', 0, 5))];
  const incoming = row(runBase('r-peer', 'h1', 'R-9', 0, 5, ), B, '2026-09-12');
  // 无基线、同 runNo/同区间 → 双方各建
  const pkg = makePkg({ upserts: { runs: [incoming] } });
  const r = reconcile(pkg, { holes: [hole], runs: local, boxes: [], lithos: [] }, emptyCursor);
  expectStatus(find(r.items, 'runs', 'r-peer'), 'pending');
  assert.equal(find(r.items, 'runs', 'r-peer').targetId, 'r-local');
});

console.log('岩芯箱：');
runCase('新箱自动并入', () => {
  const hole = row(holeBase('h1'));
  const box = row(boxBase('b1', 'h1', 'X-01', 0, 5), B);
  const pkg = makePkg({ upserts: { boxes: [box] } });
  const r = reconcile(pkg, { holes: [hole], runs: [], boxes: [], lithos: [] }, emptyCursor);
  expectStatus(find(r.items, 'boxes', 'b1'), 'auto', 'upsert');
});

runCase('同箱号两边各编 → 待处理，避免重复箱号', () => {
  const hole = row(holeBase('h1'));
  const local = [row(boxBase('b-local', 'h1', 'X-01', 0, 5))];
  const incoming = row(boxBase('b-peer', 'h1', 'X-01', 0, 5), B);
  const pkg = makePkg({ upserts: { boxes: [incoming] } });
  const r = reconcile(pkg, { holes: [hole], runs: [], boxes: local, lithos: [] }, emptyCursor);
  expectStatus(find(r.items, 'boxes', 'b-peer'), 'pending');
});

runCase('与待处理回次深度重叠的箱 → 挂起', () => {
  const hole = row(holeBase('h1'));
  // 回次同段两边各改 → pending
  const rb = row(runBase('r1', 'h1', 'R-1', 0, 5));
  const localRun = [edit(rb, { recorder: '甲改' }, A, '2026-09-12')];
  const peerRun = edit(rb, { recorder: '乙改' }, B, '2026-09-13');
  const baseline = { ...emptyCursor, runs: snapshotOf([rb]) };
  const box = row(boxBase('bx1', 'h1', 'X-01', 0, 5), B);
  const pkg = makePkg({ upserts: { runs: [peerRun], boxes: [box] }, baseline });
  const r = reconcile(pkg, { holes: [hole], runs: localRun, boxes: [], lithos: [] }, emptyCursor);
  expectStatus(find(r.items, 'runs', 'r1'), 'pending');
  expectStatus(find(r.items, 'boxes', 'bx1'), 'held');
});

console.log('岩性：');
runCase('新区间自动并入', () => {
  const hole = row(holeBase('h1'));
  const litho = row(lithoBase('l1', 'h1', 0, 5), B);
  const pkg = makePkg({ upserts: { lithos: [litho] } });
  const r = reconcile(pkg, { holes: [hole], runs: [], boxes: [], lithos: [] }, emptyCursor);
  expectStatus(find(r.items, 'lithos', 'l1'), 'auto', 'upsert');
});

runCase('本机已登记样品，对端改样品号 → 待处理且样品受保护', () => {
  const base = row(lithoBase('l1', 'h1', 0, 5, 'YP-1'));
  const local = [edit(base, { color: '甲改色' }, A, '2026-09-12')];
  const incoming = edit(base, { sampleNo: 'YP-9', color: '乙改色' }, B, '2026-09-13');
  const baseline = { ...emptyCursor, lithos: snapshotOf([base]) };
  const pkg = makePkg({ upserts: { lithos: [incoming] }, baseline });
  const r = reconcile(pkg, { holes: [row(holeBase('h1'))], runs: [], boxes: [], lithos: local }, emptyCursor);
  const item = find(r.items, 'lithos', 'l1');
  expectStatus(item, 'pending');
  assert.ok(item.hardProtected);
  assert.deepEqual(item.protectedFields, ['样品号']);
});

runCase('同孔重叠岩性区间两边各编 → 待处理，不重复生成区间', () => {
  const hole = row(holeBase('h1'));
  const local = [row(lithoBase('l-local', 'h1', 0, 10))];
  const incoming = row(lithoBase('l-peer', 'h1', 5, 15), B);
  const pkg = makePkg({ upserts: { lithos: [incoming] } });
  const r = reconcile(pkg, { holes: [hole], runs: [], boxes: [], lithos: local }, emptyCursor);
  expectStatus(find(r.items, 'lithos', 'l-peer'), 'pending');
});

runCase('对端删带样品区间 → 待处理，样品事实保护', () => {
  const hole = row(holeBase('h1'));
  const local = [row(lithoBase('l1', 'h1', 0, 5, 'YP-1'))];
  const pkg = makePkg({ deletes: { lithos: ['l1'] } });
  const r = reconcile(pkg, { holes: [hole], runs: [], boxes: [], lithos: local }, emptyCursor);
  expectStatus(find(r.items, 'lithos', 'l1'), 'pending');
  assert.ok(find(r.items, 'lithos', 'l1').hardProtected);
});

runCase('通用包（target=*）基线为空也能对账', () => {
  const incoming = row(holeBase('h-new'), B);
  const pkg = makePkg({ upserts: { holes: [incoming] }, target: ANY_PEER });
  const r = reconcile(pkg, { holes: [], runs: [], boxes: [], lithos: [] }, emptyCursor);
  expectStatus(find(r.items, 'holes', 'h-new'), 'auto', 'upsert');
});

runCase('旧数据缺来源字段：兼容回填为本机初版且修订号可复算', () => {
  const legacy = holeBase('h-legacy') as SourcedRow;
  const stamped = ensureOrigin(legacy, A);
  assert.ok(stamped._origin, '必须回填 _origin');
  assert.equal(stamped._origin.deviceId, A.id);
  assert.equal(stamped._origin.rev, contentRev(stamped));
  // 已有 _origin 且 rev 正确时幂等（同一对象、不新增修订）
  assert.equal(ensureOrigin(stamped, A), stamped);
});

if (process.exitCode) {
  console.error('\n存在失败用例');
} else {
  console.log('\n全部通过');
}
