import Dexie, { type Table } from 'dexie';
import type { DrillHole } from '../types/drill-hole';
import type { DrillRun } from '../types/drill-run';
import type { CoreBox } from '../types/core-box';
import type { LithoLog } from '../types/litho-log';
import { ensureOrigin, type DeviceIdentity, type SourcedRow } from './provenance';

/** IndexedDB 库名（浏览器本地存储，无后端） */
export const DB_NAME = 'gbdrillcore-db';

/** 当前 schema 版本，与 db.version(n) 对应 */
export const SCHEMA_VERSION = 3;

/** meta 表键名 */
export const META_DEVICE = 'deviceIdentity';
export const META_SEEDED = 'seeded';
/** 同步基线前缀：`sync:<peerId>` → 对端各表 id→rev 基线 */
export const META_SYNC_PREFIX = 'sync:';

class DrillCoreDB extends Dexie {
  holes!: Table<DrillHole, string>;
  runs!: Table<DrillRun, string>;
  boxes!: Table<CoreBox, string>;
  lithos!: Table<LithoLog, string>;
  meta!: Table<{ key: string; value: string }, string>;
  /** 差量导入暂存区：导入对账后待应用/待处理的整包快照（整包原子写入的一部分） */
  mergeStaging!: Table<{ key: string; value: unknown }, string>;

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
    // 升级前请在顶栏「导出备份」导出 JSON。
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

    // v3：差量合并支持。
    //  - 新增 mergeStaging 暂存表（导入对账结果先落暂存，整包应用失败可原样重试）
    //  - 四张旧表记录回填 _origin 来源与基线修订号（旧数据按兼容规则视为本机初版）
    // 注意：业务表 stores 声明保持不变，_origin 为非索引字段。
    this.version(3)
      .stores({
        holes: 'id, holeNo, rigNo, shift, startDate',
        runs: 'id, runNo, holeId, fromDepth, toDepth, shift',
        boxes: 'id, boxNo, holeId, shelfPos, boxedAt',
        lithos: 'id, holeId, fromDepth, toDepth, [holeId+fromDepth], lithology',
        meta: 'key',
        mergeStaging: 'key',
      })
      .upgrade(async (tx) => {
        const metaRow = await tx.table('meta').get(META_DEVICE);
        const identity = parseIdentity(metaRow?.value) ?? bootstrapIdentity();
        await tx.table('meta').put({ key: META_DEVICE, value: JSON.stringify(identity) });
        for (const tableName of ['holes', 'runs', 'boxes', 'lithos'] as const) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: SourcedRow) => {
              const stamped = ensureOrigin(row, identity);
              Object.assign(row, stamped);
            });
        }
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

/** 生成本机设备标识（只生成，不落库） */
export function bootstrapIdentity(): DeviceIdentity {
  const rand = Math.random().toString(36).slice(2, 8);
  return {
    id: `dev-${Date.now().toString(36)}-${rand}`,
    name: `编录本-${rand.slice(0, 4)}`,
    createdAt: new Date().toISOString(),
  };
}

function parseIdentity(raw: string | undefined): DeviceIdentity | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<DeviceIdentity>;
    if (parsed && typeof parsed.id === 'string' && typeof parsed.name === 'string') {
      return {
        id: parsed.id,
        name: parsed.name,
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
      };
    }
  } catch {
    // 损坏的标识按未初始化处理
  }
  return undefined;
}

/** 取本机设备标识，首次调用时生成并落库 */
export async function getDeviceIdentity(): Promise<DeviceIdentity> {
  const raw = await getMeta(META_DEVICE);
  const identity = parseIdentity(raw);
  if (identity) return identity;
  const created = bootstrapIdentity();
  await setMeta(META_DEVICE, JSON.stringify(created));
  return created;
}

/** 重命名本机（设备 id 不变，只改显示名） */
export async function renameDevice(name: string): Promise<DeviceIdentity> {
  const identity = await getDeviceIdentity();
  const next: DeviceIdentity = { ...identity, name: name.trim() || identity.name };
  await setMeta(META_DEVICE, JSON.stringify(next));
  return next;
}

/** 确保四表记录都带来源（首次升级之外的兜底，比如旧整库备份恢复进来的裸数据） */
export async function backfillAllOrigins(identity: DeviceIdentity): Promise<number> {
  let touched = 0;
  await db.transaction('rw', db.holes, db.runs, db.boxes, db.lithos, async () => {
    for (const table of [db.holes, db.runs, db.boxes, db.lithos]) {
      const rows = await table.toArray();
      for (const row of rows as unknown as SourcedRow[]) {
        const stamped = ensureOrigin(row, identity);
        if (stamped !== row) {
          touched += 1;
          await table.put(stamped as never);
        }
      }
    }
  });
  return touched;
}
