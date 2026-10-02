/**
 * 差量合并整包应用的 IndexedDB 集成测试（Node + fake-indexeddb）：
 *   npm --prefix frontend run test:merge-io
 */
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { db, DB_NAME, META_DEVICE } from '../src/utils/db';
import { stampCreate, stampUpdate, type DeviceIdentity, type SourcedRow } from '../src/utils/provenance';
import { parseDeltaPackage, buildDeltaPackage, listPeers } from '../src/utils/deltaPackage';
import { stageReconciliation, loadStaged, applyStagedMerge, setResolution, MergeGuardError } from '../src/utils/mergeIO';

const A: DeviceIdentity = { id: 'dev-A', name: '甲机', createdAt: '2026-09-01T00:00:00.000Z' };
const B: DeviceIdentity = { id: 'dev-B', name: '乙机', createdAt: '2026-09-01T00:00:00.000Z' };

let seq = 0;
function test(name: string, fn: () => Promise<void>) {
  seq += 1;
  const n = seq;
  const run = async () => {
    try {
      await reset();
      await fn();
      console.log(`  ok ${n} - ${name}`);
    } catch (error) {
      console.error(`  FAIL ${n} - ${name}`);
      console.error(error);
      process.exitCode = 1;
    }
  };
  queue.push(run);
}
const queue: Array<() => Promise<void>> = [];

async function reset() {
  await db.transaction('rw', db.holes, db.runs, db.boxes, db.lithos, db.meta, db.mergeStaging, async () => {
    await Promise.all([db.holes.clear(), db.runs.clear(), db.boxes.clear(), db.lithos.clear(), db.meta.clear(), db.mergeStaging.clear()]);
  });
  await db.meta.put({ key: META_DEVICE, value: JSON.stringify(A) });
}

const hole = (id: string, extra: Record<string, unknown> = {}): SourcedRow =>
  stampCreate(
    {
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
      ...extra,
    } as SourcedRow,
    A,
  );

const run = (id: string, extra: Record<string, unknown> = {}): SourcedRow =>
  stampCreate(
    {
      id,
      runNo: id,
      holeId: 'h1',
      fromDepth: 0,
      toDepth: 5,
      footage: 5,
      coreLength: 5,
      recovery: 100,
      waterLevel: 0,
      shift: '甲班',
      drilledAt: '2026-09-05',
      recorder: '张三',
      ...extra,
    } as SourcedRow,
    A,
  );

const box = (id: string, extra: Record<string, unknown> = {}): SourcedRow =>
  stampCreate(
    {
      id,
      boxNo: id,
      holeId: 'h1',
      fromDepth: 0,
      toDepth: 5,
      slots: 10,
      slotLength: 0.5,
      boxedAt: '2026-09-06',
      shelfPos: 'A 区 1 架',
      damagedSlots: [],
      operator: '李四',
      ...extra,
    } as SourcedRow,
    A,
  );

const litho = (id: string, extra: Record<string, unknown> = {}): SourcedRow =>
  stampCreate(
    {
      id,
      holeId: 'h1',
      fromDepth: 0,
      toDepth: 5,
      lithology: '花岗闪长岩',
      color: '灰白',
      alteration: '无',
      mineralization: '无',
      rqd: 80,
      sampleNo: '',
      logger: '王五',
      ...extra,
    } as SourcedRow,
    A,
  );

/** 构造对端差量包文本 */
function pkgText(opts: {
  holes?: SourcedRow[];
  runs?: SourcedRow[];
  boxes?: SourcedRow[];
  lithos?: SourcedRow[];
  holeDeletes?: string[];
  runDeletes?: string[];
  boxDeletes?: string[];
  lithoDeletes?: string[];
  target?: string;
}): string {
  const seg = (upserts: SourcedRow[] | undefined, deletes: string[] | undefined) => ({
    upserts: upserts ?? [],
    deletes: (deletes ?? []).map((id) => ({ id })),
  });
  return JSON.stringify({
    app: 'gbdrillcore',
    kind: 'gbdrillcore-delta',
    formatVersion: 1,
    schemaVersion: 3,
    source: { id: B.id, name: B.name },
    target: opts.target ?? A.id,
    exportedAt: '2026-09-20T00:00:00.000Z',
    baseline: { holes: {}, runs: {}, boxes: {}, lithos: {} },
    changes: {
      holes: seg(opts.holes, opts.holeDeletes),
      runs: seg(opts.runs, opts.runDeletes),
      boxes: seg(opts.boxes, opts.boxDeletes),
      lithos: seg(opts.lithos, opts.lithoDeletes),
    },
  });
}

async function stage(text: string) {
  return stageReconciliation(parseDeltaPackage(text));
}

const find = (staged: NonNullable<Awaited<ReturnType<typeof loadStaged>>>, table: string, id: string) => {
  const item = staged.items.find((entry) => entry.table === table && entry.incomingId === id);
  assert.ok(item, `缺少对账单 ${table}:${id}`);
  return item!;
};

/* ============================== 用例 ============================== */

test('整包应用：新钻孔/回次/箱/岩性自动并入', async () => {
  await db.holes.put(hole('h-old', { holeNo: 'ZK-0' }));
  const newHole = stampCreate({ ...hole('h-new'), holeNo: 'ZK-N' } as SourcedRow, B);
  const newRun = stampCreate({ ...run('r-new'), holeId: 'h-new' } as SourcedRow, B);
  const newBox = stampCreate({ ...box('b-new'), holeId: 'h-new' } as SourcedRow, B);
  const newLitho = stampCreate({ ...litho('l-new'), holeId: 'h-new' } as SourcedRow, B);
  await stage(pkgText({ holes: [newHole], runs: [newRun], boxes: [newBox], lithos: [newLitho] }));
  const result = await applyStagedMerge(A);
  assert.equal(result.upserted, 4);
  assert.equal(await db.holes.where('holeNo').equals('ZK-N').count(), 1);
  assert.equal(await db.runs.get('r-new') !== undefined, true);
  assert.equal(await db.boxes.get('b-new') !== undefined, true);
  assert.equal(await db.lithos.get('l-new') !== undefined, true);
  // 旧数据原样保留
  assert.equal(await db.holes.get('h-old') !== undefined, true);
  // 对端已登记
  const stagedAfter = await loadStaged();
  assert.equal(stagedAfter, undefined);
});

test('终孔事实：禁止整行采用导入，可选并入非保护字段', async () => {
  const base = hole('h1', { finalDepth: 180, endDate: '2026-09-18', rigNo: 'XY-1', remark: '基线' });
  await db.holes.put(base);
  const localHole = stampUpdate(base, { ...base, remark: '本机补注' } as SourcedRow, A, '2026-09-19T00:00:00.000Z');
  await db.holes.put(localHole);
  const incoming = stampUpdate(
    base,
    { ...base, finalDepth: 200, endDate: '2026-09-20', rigNo: 'XY-2' } as SourcedRow,
    B,
    '2026-09-20T00:00:00.000Z',
  );
  // 包基线给出共同祖先 base
  const text = JSON.stringify({
    ...JSON.parse(pkgText({})),
    baseline: { holes: { h1: base._origin!.rev }, runs: {}, boxes: {}, lithos: {} },
    changes: {
      holes: { upserts: [incoming], deletes: [] },
      runs: { upserts: [], deletes: [] },
      boxes: { upserts: [], deletes: [] },
      lithos: { upserts: [], deletes: [] },
    },
  });
  const staged = await stage(text);
  const item = find(staged, 'holes', 'h1');
  assert.equal(item.status, 'pending');
  assert.equal(item.hardProtected, true);
  await assert.rejects(() => setResolution(item.itemId, 'take-incoming'), MergeGuardError);
  await setResolution(item.itemId, 'merge-incoming-nonprotected');
  await applyStagedMerge(A);
  const finalRow = await db.holes.get('h1');
  assert.equal(finalRow!.finalDepth, 180, '终孔深度必须保留本机');
  assert.equal(finalRow!.endDate, '2026-09-18', '终孔日期必须保留本机');
  assert.equal(finalRow!.rigNo, 'XY-2', '非保护字段应采用导入');
  assert.equal(finalRow!.remark, '基线', '非保护字段应采用导入');
});

test('样品事实：并入非保护字段时样品号锁本机', async () => {
  await db.holes.put(hole('h1'));
  const base = litho('l1', { sampleNo: 'YP-1', color: '灰白' });
  await db.lithos.put(base);
  const localLitho = stampUpdate(base, { ...base, color: '灰白-本机' } as SourcedRow, A, '2026-09-19T00:00:00.000Z');
  await db.lithos.put(localLitho);
  const incoming = stampUpdate(base, { ...base, sampleNo: 'YP-9', color: '灰白-对端' } as SourcedRow, B, '2026-09-20T00:00:00.000Z');
  const text = JSON.stringify({
    ...JSON.parse(pkgText({})),
    baseline: { lithos: { l1: base._origin!.rev }, holes: {}, runs: {}, boxes: {} },
    changes: {
      holes: { upserts: [], deletes: [] },
      runs: { upserts: [], deletes: [] },
      boxes: { upserts: [], deletes: [] },
      lithos: { upserts: [incoming], deletes: [] },
    },
  });
  const staged = await stage(text);
  const item = find(staged, 'lithos', 'l1');
  assert.equal(item.status, 'pending');
  assert.deepEqual(item.protectedFields, ['样品号']);
  await setResolution(item.itemId, 'merge-incoming-nonprotected');
  await applyStagedMerge(A);
  const finalRow = await db.lithos.get('l1');
  assert.equal(finalRow!.sampleNo, 'YP-1');
  assert.equal(finalRow!.color, '灰白-对端');
});

test('陈旧暂存：对账后本机又改过 → 整包中止，四张旧表保留可重试', async () => {
  await db.holes.put(hole('h1'));
  const base = run('r1', { recorder: '张三' });
  await db.runs.put(base);
  const incoming = stampUpdate(base, { ...base, recorder: '李四' } as SourcedRow, B, '2026-09-20T00:00:00.000Z');
  const text = JSON.stringify({
    ...JSON.parse(pkgText({})),
    baseline: { runs: { r1: base._origin!.rev }, holes: {}, boxes: {}, lithos: {} },
    changes: {
      holes: { upserts: [], deletes: [] },
      runs: { upserts: [incoming], deletes: [] },
      boxes: { upserts: [], deletes: [] },
      lithos: { upserts: [], deletes: [] },
    },
  });
  await stage(text);
  // 对账之后、应用之前，本机又改了该回次
  await db.runs.put(stampUpdate(base, { ...base, recorder: '本机后改' } as SourcedRow, A, '2026-09-21T00:00:00.000Z'));
  await assert.rejects(() => applyStagedMerge(A), MergeGuardError);
  let row = await db.runs.get('r1');
  assert.equal(row!.recorder, '本机后改', '失败后必须保留本机原值');
  // 暂存仍在，可重新对账
  assert.equal((await loadStaged()) !== undefined, true);
  // 重新对账 → 两边都改 → 待处理；选保留本机后应用成功
  await stage(text);
  const staged2 = await loadStaged();
  const item = find(staged2!, 'runs', 'r1');
  assert.equal(item.status, 'pending');
  await setResolution(item.itemId, 'keep-local');
  await applyStagedMerge(A);
  row = await db.runs.get('r1');
  assert.equal(row!.recorder, '本机后改');
});

test('事务守卫：同箱号冲突导致整包回滚，同包其他自动项不落库，可重试', async () => {
  await db.holes.put(hole('h1'));
  await db.boxes.put(box('b1', { boxNo: 'X-01' }));
  // 手工构造一份"漏过对账"的暂存：同箱号新箱（不同 id）+ 一条本该并入的新回次
  const dupBox = stampCreate(box('b-guard', { boxNo: 'X-01', fromDepth: 50, toDepth: 55 }), B);
  const newRun = stampCreate(run('r-ok', { fromDepth: 20, toDepth: 25 }), B);
  await db.mergeStaging.put({
    key: 'current',
    value: {
      pkg: JSON.parse(pkgText({})),
      items: [
        { itemId: 'boxes:b-guard', table: 'boxes', status: 'auto', action: 'upsert', reason: 't', incomingId: 'b-guard', targetId: 'b-guard', incomingRow: dupBox },
        { itemId: 'runs:r-ok', table: 'runs', status: 'auto', action: 'upsert', reason: 't', incomingId: 'r-ok', targetId: 'r-ok', incomingRow: newRun },
      ],
      resolutions: {},
      stagedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  await assert.rejects(() => applyStagedMerge(A), MergeGuardError);
  // 同包的回次也不得落库（证明整包回滚）
  assert.equal(await db.runs.get('r-ok'), undefined);
  assert.equal((await db.boxes.where('boxNo').equals('X-01').toArray()).length, 1, '不得出现重复箱号');
  // 暂存保留可重试
  assert.equal((await loadStaged()) !== undefined, true);
});

test('自然键重复：同箱号两边各编 → 待处理；选保留本机后不产生重复箱', async () => {
  await db.holes.put(hole('h1'));
  await db.boxes.put(box('b-local', { boxNo: 'X-01' }));
  const incoming = stampCreate(box('b-peer', { boxNo: 'X-01' }), B);
  const staged = await stage(pkgText({ boxes: [incoming] }));
  const item = find(staged, 'boxes', 'b-peer');
  assert.equal(item.status, 'pending');
  assert.equal(item.targetId, 'b-local');
  await setResolution(item.itemId, 'keep-local');
  await applyStagedMerge(A);
  assert.equal((await db.boxes.where('boxNo').equals('X-01').toArray()).length, 1);
  assert.equal(await db.boxes.get('b-peer'), undefined);
});

test('整孔删除带样品子记录 → 不允许；确认删除前必须先处理子记录（孤儿守卫）', async () => {
  const h = hole('h1');
  await db.holes.put(h);
  await db.lithos.put(litho('l1', { sampleNo: 'YP-1' }));
  // 手工暂存：孔确认删除但子记录不在删除清单
  await db.mergeStaging.put({
    key: 'current',
    value: {
      pkg: JSON.parse(pkgText({})),
      items: [
        { itemId: 'holes:h1', table: 'holes', status: 'pending', action: 'keep', reason: 't', incomingId: 'h1', targetId: 'h1', localRow: h },
      ],
      resolutions: { 'holes:h1': 'confirm-delete' },
      stagedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  await assert.rejects(() => applyStagedMerge(A), MergeGuardError);
  assert.equal(await db.holes.get('h1') !== undefined, true, '钻孔必须仍在');
});

test('导出：通用包为全量且标注来源；定向包只含增量并带基线版本', async () => {
  await db.holes.put(hole('h1'));
  await db.runs.put(run('r1'));

  // 通用包：全量
  const universal = await buildDeltaPackage({});
  assert.equal(universal.kind, 'gbdrillcore-delta');
  assert.equal(universal.source.id, A.id);
  assert.equal(universal.target, '*');
  assert.equal(universal.changes.holes.upserts.length, 1);
  assert.equal(universal.changes.runs.upserts.length, 1);
  assert.ok(universal.changes.holes.upserts[0]._origin, '记录必须带来源标注');

  // 定向给乙机的首次包：当前库全量，且把乙机游标记为当前快照
  const first = await buildDeltaPackage({ target: B.id, targetName: B.name });
  assert.equal(first.changes.holes.upserts.length, 1);
  assert.equal(first.baseline.holes.h1 !== undefined, false, '首次发包基线为空');

  // 对端导入后，本机这里再改一条；第二次定向包应只含这一条变更
  const h1 = await db.holes.get('h1');
  await db.holes.put(stampUpdate(h1, { ...h1, rigNo: 'XY-4' } as SourcedRow, A, '2026-09-21T00:00:00.000Z'));
  const second = await buildDeltaPackage({ target: B.id, targetName: B.name });
  assert.equal(second.changes.holes.upserts.length, 1, '第二次定向包只含变更钻孔');
  assert.equal(second.changes.runs.upserts.length, 0, '未改的回次不进增量包');
  assert.equal(second.changes.holes.upserts[0].rigNo, 'XY-4');
  assert.ok(second.baseline.holes.h1, '第二次包基线记录了上版修订号');

  const peers = await listPeers();
  assert.equal(peers.some((peer) => peer.id === B.id && peer.name === B.name), true);
});

test('导出：删除记录在定向包中体现为墓碑', async () => {
  await db.holes.put(hole('h1'));
  await buildDeltaPackage({ target: B.id, targetName: B.name });
  await db.holes.delete('h1');
  const pkg = await buildDeltaPackage({ target: B.id, targetName: B.name });
  assert.deepEqual(pkg.changes.holes.deletes.map((tomb) => tomb.id), ['h1']);
});

/* ============================== 执行 ============================== */

void DB_NAME;

(async () => {
  for (const fn of queue) {
    await fn();
  }
  if (process.exitCode) {
    console.error('\n存在失败用例');
  } else {
    console.log('\n全部通过');
  }
})();
