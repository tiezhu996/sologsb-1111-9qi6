// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { db, DB_NAME, SCHEMA_VERSION } from '../utils/db';
import { LEGACY_NODE_ID } from './clock';

async function deleteDb() {
  await Dexie.delete(DB_NAME);
}

/**
 * v2 → v3 升级：旧库四张表没有来源字段，升级后必须按兼容规则回填公共祖先信封。
 */
describe('schema v3 升级回填', () => {
  beforeEach(deleteDb);

  it('旧记录升级后带上 __legacy__@1 来源信封', async () => {
    // 用一个只声明到 v2 的 Dexie 实例造旧库
    const old = new Dexie(DB_NAME) as Dexie & {
      holes: { put: (row: Record<string, unknown>) => Promise<unknown> };
      lithos: { put: (row: Record<string, unknown>) => Promise<unknown> };
    };
    old.version(1).stores({
      holes: 'id, holeNo, rigNo, shift, startDate',
      runs: 'id, runNo, holeId, fromDepth, toDepth, shift',
      boxes: 'id, boxNo, holeId, shelfPos, boxedAt',
      lithos: 'id, holeId, fromDepth, toDepth, lithology',
      meta: 'key',
    });
    old.version(2).stores({
      holes: 'id, holeNo, rigNo, shift, startDate',
      runs: 'id, runNo, holeId, fromDepth, toDepth, shift',
      boxes: 'id, boxNo, holeId, shelfPos, boxedAt',
      lithos: 'id, holeId, fromDepth, toDepth, [holeId+fromDepth], lithology',
      meta: 'key',
    });
    await old.holes.put({
      id: 'old-1',
      holeNo: 'ZK-OLD',
      coordX: 1,
      coordY: 2,
      collarElevation: 100,
      designDepth: 100,
      finalDepth: 0,
      startDate: '2025-01-01',
      rigNo: 'XY-1',
      shift: '甲班',
      surveyData: [],
    });
    await old.lithos.put({
      id: 'old-l1',
      holeId: 'old-1',
      fromDepth: 0,
      toDepth: 5,
      lithology: '花岗闪长岩',
      color: '灰白',
      alteration: '无',
      mineralization: '无',
      rqd: 80,
      sampleNo: '',
      logger: '甲',
    });
    old.close();

    // 打开当前 schema（v3），触发升级回填
    expect(SCHEMA_VERSION).toBe(3);
    await db.open();

    const hole = await db.holes.get('old-1');
    expect(hole?.nodeId).toBe(LEGACY_NODE_ID);
    expect(hole?.vv).toEqual({ [LEGACY_NODE_ID]: 1 });
    expect(hole?.legacy).toBe(true);
    expect(hole?.baseVv).toEqual({});

    const litho = await db.lithos.get('old-l1');
    expect(litho?.nodeId).toBe(LEGACY_NODE_ID);
    expect(litho?.vv).toEqual({ [LEGACY_NODE_ID]: 1 });

    // 新表存在
    expect(await db.tombstones.count()).toBe(0);
    expect(await db.pending.count()).toBe(0);

    db.close();
  });
});
