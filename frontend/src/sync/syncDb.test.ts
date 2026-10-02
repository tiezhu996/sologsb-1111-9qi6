// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 整包写入的端到端对账落库测试（Dexie + fake-indexeddb）：
 * - 写前四表备份、失败旧表保留、可重试/可回滚；
 * - 待处理项落 pending 表，不被自动覆盖；
 * - 编录员裁决后加盖本机版本落库。
 */
// 在 fake-indexeddb 装好全局后静态加载，保证 Dexie 探测到 IndexedDB
const dbMod = await import('../utils/db');
const mod = await import('./syncDb');

async function resetDatabase() {
  dbMod.db.close();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(dbMod.DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('deleteDatabase blocked'));
  });
  // 删除后显式重新打开，Dexie 会在空库上重建到当前 schema
  await dbMod.db.open();
}

beforeEach(async () => {
  await resetDatabase();
});

afterEach(async () => {
  vi.restoreAllMocks();
});

async function seedRows() {
  const stamp = {
    nodeId: 'A',
    vv: { A: 1 },
    baseVv: {},
    updatedAt: new Date().toISOString(),
  };
  await dbMod.db.holes.put({
    id: 'h1',
    holeNo: 'ZK-01',
    coordX: 1,
    coordY: 2,
    collarElevation: 100,
    designDepth: 200,
    finalDepth: 0,
    startDate: '2026-01-01',
    rigNo: 'XY-1',
    shift: '甲班',
    surveyData: [],
    ...stamp,
  });
  await dbMod.db.meta.put({ key: 'sync.nodeId', value: 'A' });
  await dbMod.db.meta.put({ key: 'sync.watermark', value: JSON.stringify({ A: 1 }) });
}

function incomingPackage(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    app: 'gbdrillcore-sync',
    kind: 'delta',
    formatVersion: 1,
    nodeId: 'B',
    nodeName: '乙机',
    exportedAt: new Date().toISOString(),
    schemaVersion: 3,
    watermark: { A: 1, B: 1 },
    since: null,
    holes: [
      {
        id: 'h1',
        holeNo: 'ZK-01',
        coordX: 1,
        coordY: 2,
        collarElevation: 100,
        designDepth: 200,
        finalDepth: 0,
        startDate: '2026-01-01',
        rigNo: 'XY-1',
        shift: '甲班',
        surveyData: [],
        remark: '对方补的备注',
        nodeId: 'B',
        vv: { A: 1, B: 1 },
        baseVv: { A: 1 },
        updatedAt: new Date().toISOString(),
        ...overrides,
      },
    ],
    runs: [],
    boxes: [],
    lithos: [],
    tombstones: [],
  });
}

describe('commitMerge 整包写入', () => {
  it('正常写入：自动快进、水位合并、备份保留成功状态', async () => {
    await seedRows();
    const { plan } = await mod.commitMerge(incomingPackage());
    expect(plan.stats.remoteUpdate).toBe(1);

    const h1 = await dbMod.db.holes.get('h1');
    expect(h1?.remark).toBe('对方补的备注');
    expect(h1?.vv).toEqual({ A: 1, B: 1 });

    const watermark = JSON.parse((await dbMod.db.meta.get('sync.watermark'))!.value);
    expect(watermark).toEqual({ A: 1, B: 1 });

    const backup = await mod.getBackupMeta();
    expect(backup?.status).toBe('succeeded');
    expect(await dbMod.db.holesBackup.count()).toBe(1);
  });

  it('阶段二失败：四张旧表完整保留，备份标记 failed，可回滚', async () => {
    await seedRows();
    const text = incomingPackage();

    // 在阶段二事务内对 holes 写入做强制失败（阶段一备份只写备份表与 meta，不受影响）
    const spy = vi.spyOn(dbMod.db.holes, 'put').mockRejectedValue(new Error('disk full (mock)'));
    await expect(mod.commitMerge(text)).rejects.toThrow(/disk full/);
    spy.mockRestore();

    // 旧表未动（无 remark）
    const h1AfterFail = await dbMod.db.holes.get('h1');
    expect(h1AfterFail?.remark).toBeUndefined();

    // 备份保留且状态为 failed
    const failed = await mod.getBackupMeta();
    expect(failed?.status).toBe('failed');
    expect(await dbMod.db.holesBackup.count()).toBe(1);

    // 回滚后四张旧表恢复、备份被清除（可回到「确认写入前」状态后重新对账）
    await mod.restoreFromBackup();
    expect(await mod.getBackupMeta()).toBeUndefined();
    expect((await dbMod.db.holes.get('h1'))?.remark).toBeUndefined();
  });

  it('阶段二失败后可整包重试：四张旧表保留期间重试成功，备份转为 succeeded', async () => {
    await seedRows();
    const text = incomingPackage();
    const spy = vi.spyOn(dbMod.db.holes, 'put').mockRejectedValue(new Error('boom'));
    await expect(mod.commitMerge(text)).rejects.toThrow();
    spy.mockRestore();

    // 重试：失败状态的备份不拦截，直接重放整包写入
    const { plan } = await mod.commitMerge(text);
    expect(plan.stats.remoteUpdate).toBe(1);
    expect((await dbMod.db.holes.get('h1'))?.remark).toBe('对方补的备注');
    expect((await mod.getBackupMeta())?.status).toBe('succeeded');
  });

  it('已成功但未确认的备份存在时拒绝再次合并，防止覆盖四张旧表备份', async () => {
    await seedRows();
    await mod.commitMerge(incomingPackage()); // 成功，备份仍在
    await expect(mod.commitMerge(incomingPackage())).rejects.toThrow(/未确认/);
  });

  it('待处理项写 pending 表、本地终孔事实不被覆盖；裁决采用对方后才落库', async () => {
    await seedRows();
    // 本地先确认终孔
    const h1 = (await dbMod.db.holes.get('h1'))!;
    await dbMod.db.holes.put({ ...h1, finalDepth: 180, endDate: '2026-09-01', vv: { A: 2 }, nodeId: 'A' });

    // 对方要把终孔深度改成 999（单边修改，受保护）
    const text = incomingPackage({ finalDepth: 999, endDate: '2026-10-01', vv: { A: 2, B: 1 }, baseVv: { A: 2 } });
    const { plan } = await mod.commitMerge(text);

    expect(plan.pending).toHaveLength(1);
    const still = await dbMod.db.holes.get('h1');
    expect(still?.finalDepth).toBe(180); // 事实未被覆盖

    const items = await mod.listPending();
    expect(items[0]).toMatchObject({ reason: 'protected', protectedFields: expect.arrayContaining(['finalDepth']) });

    // 编录员显式裁决：采用对方（在对方版本上加盖本机版本，两个节点维度都保留）
    await mod.resolvePending(items[0].id, 'remote');
    const overridden = await dbMod.db.holes.get('h1');
    expect(overridden?.finalDepth).toBe(999);
    expect(overridden?.vv).toEqual({ A: 3, B: 1 }); // 本机裁决盖新版本，对方维度保留
    expect(overridden?.baseVv).toEqual({ A: 2, B: 1 });
    expect(await dbMod.db.pending.count()).toBe(0);
  });

  it('裁决保留本地：终孔事实不动，版本仍前推表示已裁决', async () => {
    await seedRows();
    const h1 = (await dbMod.db.holes.get('h1'))!;
    await dbMod.db.holes.put({ ...h1, finalDepth: 180, endDate: '2026-09-01', vv: { A: 2 }, nodeId: 'A' });
    const text = incomingPackage({ finalDepth: 999, vv: { A: 2, B: 1 }, baseVv: { A: 2 } });
    await mod.commitMerge(text);
    const items = await mod.listPending();
    await mod.resolvePending(items[0].id, 'local');
    const kept = await dbMod.db.holes.get('h1');
    expect(kept?.finalDepth).toBe(180);
    expect(kept?.vv.A).toBe(3);
  });

  it('本地写入自动盖来源与版本；删除写墓碑，再导出差量包带墓碑', async () => {
    await dbMod.db.meta.put({ key: 'sync.nodeId', value: 'A' });
    await mod.putStamped('holes', 'h2', (stamp) => ({
      id: 'h2',
      holeNo: 'ZK-02',
      coordX: 0,
      coordY: 0,
      collarElevation: 0,
      designDepth: 100,
      finalDepth: 0,
      startDate: '2026-01-01',
      rigNo: 'XY-1',
      shift: '甲班',
      surveyData: [],
      ...stamp,
    }));
    const created = await dbMod.db.holes.get('h2');
    expect(created?.nodeId).toBe('A');
    expect(created?.vv).toEqual({ A: 1 });

    await mod.deleteStamped('holes', 'h2');
    expect(await dbMod.db.holes.get('h2')).toBeUndefined();
    const tomb = await dbMod.db.tombstones.get('holes:h2');
    expect(tomb?.vv).toEqual({ A: 2 });

    const syncPack = await mod.buildSyncPackage();
    expect(syncPack.tombstones.some((t) => t.entityId === 'h2')).toBe(true);
    expect(syncPack.nodeId).toBe('A');
  });
});
