import Dexie, { type Table } from 'dexie';
import type { DrillHole } from '../types/drill-hole';
import type { DrillRun } from '../types/drill-run';
import type { CoreBox } from '../types/core-box';
import type { LithoLog } from '../types/litho-log';
import type { PendingItem, StampedEntity, Tombstone } from '../sync/types';
import { legacyEnvelope } from '../sync/clock';

/** IndexedDB 库名（浏览器本地存储，无后端） */
export const DB_NAME = 'gbdrillcore-db';

/** 当前 schema 版本，与 db.version(n) 对应 */
export const SCHEMA_VERSION = 3;

/** 实际落库行：业务字段 + 同步信封（来源与基线版本） */
export type HoleRow = StampedEntity<DrillHole>;
export type RunRow = StampedEntity<DrillRun>;
export type BoxRow = StampedEntity<CoreBox>;
export type LithoRow = StampedEntity<LithoLog>;

class DrillCoreDB extends Dexie {
  holes!: Table<HoleRow, string>;
  runs!: Table<RunRow, string>;
  boxes!: Table<BoxRow, string>;
  lithos!: Table<LithoRow, string>;
  meta!: Table<{ key: string; value: string }, string>;
  /** 逻辑删除墓碑（差量同步用） */
  tombstones!: Table<Tombstone, string>;
  /** 待处理区（两边都改过 / 受保护事实 / 重复箱号区间） */
  pending!: Table<PendingItem, string>;
  /** 整包写入前的四张旧表备份（写入失败保留旧表并可重试 / 回滚） */
  holesBackup!: Table<HoleRow, string>;
  runsBackup!: Table<RunRow, string>;
  boxesBackup!: Table<BoxRow, string>;
  lithosBackup!: Table<LithoRow, string>;

  constructor() {
    super(DB_NAME);

    // v1：建表声明索引
    this.version(1).stores({
      holes: 'id, holeNo, rigNo, shift, startDate',
      runs: 'id, runNo, holeId, fromDepth, toDepth, shift',
      boxes: 'id, boxNo, holeId, shelfPos, boxedAt',
      lithos: 'id, holeId, fromDepth, toDepth, lithology',
      meta: 'key',
    });

    // v2：岩性表增加 (holeId+fromDepth) 复合索引，按深度区间查询更快；并回填历史 rqd 缺省值。
    this.version(2)
      .stores({
        holes: 'id, holeNo, rigNo, shift, startDate',
        runs: 'id, runNo, holeId, fromDepth, toDepth, shift',
        boxes: 'id, boxNo, holeId, shelfPos, boxedAt',
        lithos: 'id, holeId, fromDepth, toDepth, [holeId+fromDepth], lithology',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        await tx
          .table('lithos')
          .toCollection()
          .modify((row: LithoLog) => {
            if (typeof row.rqd !== 'number') {
              row.rqd = 0;
            }
          });
      });

    // v3：离线差量合并。新增 tombstones / pending 与四张「写入前备份」表；
    // 旧数据缺少来源字段，按兼容规则统一回填为公共祖先 __legacy__@1。
    this.version(3)
      .stores({
        holes: 'id, holeNo, rigNo, shift, startDate, nodeId',
        runs: 'id, runNo, holeId, fromDepth, toDepth, shift, nodeId',
        boxes: 'id, boxNo, holeId, shelfPos, boxedAt, nodeId',
        lithos: 'id, holeId, fromDepth, toDepth, [holeId+fromDepth], lithology, nodeId',
        meta: 'key',
        tombstones: 'id, table, entityId, nodeId',
        pending: 'id, table, reason, entityId',
        holesBackup: 'id',
        runsBackup: 'id',
        boxesBackup: 'id',
        lithosBackup: 'id',
      })
      .upgrade(async (tx) => {
        const backfill = (tableName: string) =>
          tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              if (typeof row.nodeId !== 'string' || !row.vv) {
                const env = legacyEnvelope();
                row.nodeId = env.nodeId;
                row.vv = env.vv;
                row.baseVv = env.baseVv;
                row.updatedAt = env.updatedAt;
                row.legacy = true;
              }
            });
        await Promise.all([backfill('holes'), backfill('runs'), backfill('boxes'), backfill('lithos')]);
      });
  }
}

export const db = new DrillCoreDB();

export async function getMeta(key: string): Promise<string | undefined> {
  const row = await db.meta.get(key);
  return row?.value;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value });
}
