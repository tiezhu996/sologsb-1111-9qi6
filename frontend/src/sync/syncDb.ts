import { db, getMeta, setMeta, SCHEMA_VERSION, type BoxRow, type HoleRow, type LithoRow, type RunRow } from '../utils/db';
import { uid } from '../utils/id';
import {
  createEnvelope,
  mergeVv,
  mergeVvInto,
  nextEnvelope,
  normVv,
} from './clock';
import { planMerge } from './merge';
import {
  ENTITY_TABLES,
  type EntityTable,
  type MergeOp,
  type MergePlan,
  type PendingItem,
  type StampedEntity,
  type SyncEnvelope,
  type SyncPackage,
  type Tombstone,
  type VersionVector,
} from './types';

const NODE_ID_KEY = 'sync.nodeId';
const NODE_NAME_KEY = 'sync.nodeName';
const WATERMARK_KEY = 'sync.watermark';
const BACKUP_META_KEY = 'sync.backupMeta';

type AnyRow = HoleRow | RunRow | BoxRow | LithoRow;
type AnyTable =
  | typeof db.holes
  | typeof db.runs
  | typeof db.boxes
  | typeof db.lithos;
type AnyBackupTable =
  | typeof db.holesBackup
  | typeof db.runsBackup
  | typeof db.boxesBackup
  | typeof db.lithosBackup;

const MAIN_TABLES: Record<EntityTable, AnyTable> = {
  holes: db.holes,
  runs: db.runs,
  boxes: db.boxes,
  lithos: db.lithos,
};

const BACKUP_TABLES: Record<EntityTable, AnyBackupTable> = {
  holes: db.holesBackup,
  runs: db.runsBackup,
  boxes: db.boxesBackup,
  lithos: db.lithosBackup,
};

// ---------------------------------------------------------------------------
// 本机节点身份
// ---------------------------------------------------------------------------

/** 本机节点编号（首次使用自动生成，可在合并中心修改显示名） */
export async function getNodeId(): Promise<string> {
  let nodeId = await getMeta(NODE_ID_KEY);
  if (!nodeId) {
    nodeId = `dev-${Math.random().toString(36).slice(2, 8)}`;
    await setMeta(NODE_ID_KEY, nodeId);
  }
  return nodeId;
}

export async function getNodeName(): Promise<string> {
  return (await getMeta(NODE_NAME_KEY)) ?? '';
}

export async function setNodeName(name: string): Promise<void> {
  await setMeta(NODE_NAME_KEY, name.trim());
}

async function getWatermark(): Promise<VersionVector> {
  const raw = await getMeta(WATERMARK_KEY);
  if (!raw) return {};
  try {
    return normVv(JSON.parse(raw) as VersionVector);
  } catch {
    return {};
  }
}

async function saveWatermark(vv: VersionVector): Promise<void> {
  await setMeta(WATERMARK_KEY, JSON.stringify(normVv(vv)));
}

/** 各来源节点的差量导出水位（{ 对方节点: 上次已交付给它的本库水位快照 JSON }） */
async function getPeerCursor(targetNodeId: string): Promise<VersionVector> {
  const raw = await getMeta(`sync.cursor.${targetNodeId}`);
  if (!raw) return {};
  try {
    return normVv(JSON.parse(raw) as VersionVector);
  } catch {
    return {};
  }
}

async function savePeerCursor(targetNodeId: string, vv: VersionVector): Promise<void> {
  await setMeta(`sync.cursor.${targetNodeId}`, JSON.stringify(normVv(vv)));
}

// ---------------------------------------------------------------------------
// 本地写入统一加盖「来源 + 基线版本」
// ---------------------------------------------------------------------------

/**
 * 新增/修改一条本地记录：自动盖上本机节点与版本向量。
 * 业务 store 的所有新增、编辑都走这里，保证每条记录可对账。
 */
export async function putStamped<T extends object>(
  table: EntityTable,
  id: string,
  build: (stampFields: SyncEnvelope) => StampedEntity<T>,
): Promise<void> {
  const nodeId = await getNodeId();
  const target = MAIN_TABLES[table] as AnyTable;
  await db.transaction('rw', target, db.meta, async () => {
    const prev = (await target.get(id)) as StampedEntity<T> | undefined;
    const envelope = prev
      ? nextEnvelope({ nodeId: prev.nodeId, vv: prev.vv, baseVv: prev.baseVv, updatedAt: prev.updatedAt }, nodeId)
      : createEnvelope(nodeId);
    const row = build(envelope);
    Object.assign(row, { id });
    await (target as { put: (row: unknown) => Promise<unknown> }).put(row);
    await advanceWatermark(envelope.vv);
  });
}

/** 逻辑删除：写墓碑并从业务表移除（墓碑参与差量对账，防止旧数据复活） */
export async function deleteStamped(table: EntityTable, entityId: string): Promise<void> {
  const nodeId = await getNodeId();
  const target = MAIN_TABLES[table] as AnyTable;
  await db.transaction('rw', target, db.tombstones, db.meta, async () => {
    const prev = (await target.get(entityId)) as AnyRow | undefined;
    const prevTomb = await db.tombstones.get(`${table}:${entityId}`);
    const envelope = nextEnvelope(
      prev
        ? { nodeId: prev.nodeId, vv: prev.vv, baseVv: prev.baseVv, updatedAt: prev.updatedAt }
        : prevTomb,
      nodeId,
    );
    const tomb: Tombstone = {
      id: `${table}:${entityId}`,
      table,
      entityId,
      nodeId: envelope.nodeId,
      vv: envelope.vv,
      baseVv: envelope.baseVv,
      updatedAt: envelope.updatedAt,
    };
    await target.delete(entityId);
    await db.tombstones.put(tomb);
    await advanceWatermark(tomb.vv);
  });
}

async function advanceWatermark(vv: VersionVector): Promise<void> {
  await saveWatermark(mergeVv(await getWatermark(), vv));
}

// ---------------------------------------------------------------------------
// 导出差量包
// ---------------------------------------------------------------------------

interface ExportOptions {
  /** 目标笔记本节点：给定时按其上次接收水位裁剪差量；不给定则导全量 */
  targetNodeId?: string;
  nodeName?: string;
}

function isChangedSince(vv: VersionVector | undefined, since: VersionVector | null): boolean {
  if (!since) return true;
  return Object.entries(normVv(vv)).some(([node, ver]) => ver > (since[node] ?? 0));
}

/** 组装差量包：标注来源节点与基线（水位）版本，只含自上次交付以来变更的记录与墓碑 */
export async function buildSyncPackage(options: ExportOptions = {}): Promise<SyncPackage> {
  const nodeId = await getNodeId();
  const watermark = await getWatermark();
  const since = options.targetNodeId ? await getPeerCursor(options.targetNodeId) : null;

  const [holes, runs, boxes, lithos, tombstones] = await Promise.all([
    db.holes.toArray(),
    db.runs.toArray(),
    db.boxes.toArray(),
    db.lithos.toArray(),
    db.tombstones.toArray(),
  ]);

  if (options.targetNodeId) {
    await savePeerCursor(options.targetNodeId, watermark);
  }

  return {
    app: 'gbdrillcore-sync',
    kind: 'delta',
    formatVersion: 1,
    nodeId,
    nodeName: options.nodeName?.trim() || undefined,
    exportedAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    watermark,
    since,
    targetNodeId: options.targetNodeId || undefined,
    holes: holes.filter((r) => isChangedSince(r.vv, since)) as unknown as SyncPackage['holes'],
    runs: runs.filter((r) => isChangedSince(r.vv, since)) as unknown as SyncPackage['runs'],
    boxes: boxes.filter((r) => isChangedSince(r.vv, since)) as unknown as SyncPackage['boxes'],
    lithos: lithos.filter((r) => isChangedSince(r.vv, since)) as unknown as SyncPackage['lithos'],
    tombstones: tombstones.filter((t) => isChangedSince(t.vv, since)),
  };
}

// ---------------------------------------------------------------------------
// 导入：解析 → 对账（纯函数）→ 整包事务写入
// ---------------------------------------------------------------------------

export class SyncPackageError extends Error {}

const PACKAGE_SEGMENTS = ['holes', 'runs', 'boxes', 'lithos', 'tombstones'] as const;

/** 解析并校验差量包（旧全量备份不在此处理，仍走备份恢复入口） */
export function parseSyncPackage(text: string): SyncPackage {
  let pack: Partial<SyncPackage>;
  try {
    pack = JSON.parse(text) as Partial<SyncPackage>;
  } catch {
    throw new SyncPackageError('文件不是合法 JSON');
  }
  if (!pack || pack.app !== 'gbdrillcore-sync') {
    throw new SyncPackageError('不是差量合并包（缺少 app=gbdrillcore-sync 标记）');
  }
  if (pack.formatVersion !== 1) {
    throw new SyncPackageError(`不支持的差量包格式版本：${String(pack.formatVersion)}（本机支持 1）`);
  }
  if (typeof pack.nodeId !== 'string' || !pack.nodeId) {
    throw new SyncPackageError('差量包缺少来源节点标识（nodeId）');
  }
  if (typeof pack.schemaVersion === 'number' && pack.schemaVersion > SCHEMA_VERSION) {
    throw new SyncPackageError(`差量包来自更新版本（schema ${pack.schemaVersion}），请先升级本机程序再合并`);
  }
  PACKAGE_SEGMENTS.forEach((name) => {
    if (pack[name] !== undefined && !Array.isArray(pack[name])) {
      throw new SyncPackageError(`差量包的 ${name} 段格式不正确`);
    }
  });
  return {
    ...(pack as object),
    watermark: normVv(pack.watermark ?? {}),
    since: pack.since ?? null,
    holes: pack.holes ?? [],
    runs: pack.runs ?? [],
    boxes: pack.boxes ?? [],
    lithos: pack.lithos ?? [],
    tombstones: pack.tombstones ?? [],
  } as SyncPackage;
}

async function readLocalState() {
  const [holes, runs, boxes, lithos, tombstones] = await Promise.all([
    db.holes.toArray(),
    db.runs.toArray(),
    db.boxes.toArray(),
    db.lithos.toArray(),
    db.tombstones.toArray(),
  ]);
  return {
    holes: holes as unknown as Record<string, unknown>[],
    runs: runs as unknown as Record<string, unknown>[],
    boxes: boxes as unknown as Record<string, unknown>[],
    lithos: lithos as unknown as Record<string, unknown>[],
    tombstones,
  };
}
export interface MergeRunInfo {
  runId: string;
  packNodeId: string;
  packNodeName?: string;
  exportedAt: string;
  startedAt: string;
  status: 'failed' | 'succeeded';
  error?: string;
  planStats: MergePlan['stats'];
  pendingCount: number;
  missingBaseline: string[];
}

/** 只对账不落库（供导入前预览） */
export async function previewMerge(text: string): Promise<{ pack: SyncPackage; plan: MergePlan }> {
  const pack = parseSyncPackage(text);
  const local = await readLocalState();
  return { pack, plan: planMerge(pack, local) };
}

/**
 * 整包写入：
 * 1. 先把四张旧表复制到备份表（事务一）；
 * 2. 再在一个事务里应用对账动作、写待处理区、更新水位（事务二）。
 * 事务二失败时四张旧表保持不变、备份表保留，可直接重试或一键回滚。
 */
export async function commitMerge(text: string): Promise<{ plan: MergePlan; pack: SyncPackage; runId: string }> {
  const pack = parseSyncPackage(text);
  const local = await readLocalState();
  const plan = planMerge(pack, local);
  const runId = uid('merge');
  const info: MergeRunInfo = {
    runId,
    packNodeId: pack.nodeId,
    packNodeName: pack.nodeName,
    exportedAt: pack.exportedAt,
    startedAt: new Date().toISOString(),
    status: 'failed',
    planStats: plan.stats,
    pendingCount: plan.pending.length,
    missingBaseline: plan.missingBaseline,
  };

  // 阶段一：备份四张旧表（事务需同时覆盖四张主表与四张备份表）
  const existing = await getBackupMeta();
  if (existing) {
    if (existing.status === 'failed') {
      // 上次整包写入失败：四张旧表没动过，允许直接重试（不再覆盖备份表）
    } else {
      throw new SyncPackageError('存在已成功但未确认的合并备份，请先回滚或确认清除后再合并');
    }
  }
  if (!existing) {
    await db.transaction(
      'rw',
      [db.holes, db.runs, db.boxes, db.lithos, db.holesBackup, db.runsBackup, db.boxesBackup, db.lithosBackup, db.meta],
      async () => {
        await Promise.all(ENTITY_TABLES.map((t) => BACKUP_TABLES[t].clear()));
        for (const t of ENTITY_TABLES) {
          const rows = await MAIN_TABLES[t].toArray();
          if (rows.length) await (BACKUP_TABLES[t] as { bulkPut: (rows: unknown[]) => Promise<unknown> }).bulkPut(rows);
        }
        await setMeta(BACKUP_META_KEY, JSON.stringify({ ...info, statusNote: '已备份四张旧表，等待整包写入' }));
      },
    );
  }

  // 阶段二：整包写入（失败则旧表不动、备份保留）
  try {
    await applyPlan(pack, plan);
    await setMeta(BACKUP_META_KEY, JSON.stringify({ ...info, status: 'succeeded', finishedAt: new Date().toISOString() }));
  } catch (error) {
    await setMeta(BACKUP_META_KEY, JSON.stringify({ ...info, status: 'failed', error: (error as Error).message })).catch(
      () => undefined,
    );
    throw error;
  }

  return { plan, pack, runId };
}

/** 应用对账结果（单个事务；任何一步失败整体回滚，四张旧表保持原样） */
async function applyPlan(pack: SyncPackage, plan: MergePlan): Promise<void> {
  await db.transaction(
    'rw',
    [db.holes, db.runs, db.boxes, db.lithos, db.tombstones, db.pending, db.meta],
    async () => {
    for (const op of plan.ops) {
      await applyOp(op);
    }

    // 待处理区：同对象已存在待处理项时替换为最新两边版本（旧待处理不进自动合并）
    for (const item of plan.pending) {
      const existing = await db.pending.get(item.id);
      await db.pending.put(existing ? { ...existing, ...item, detectedAt: item.detectedAt } : item);
    }

    // 合并水位
    const next = mergeVv(await getWatermark(), pack.watermark);
    mergeVvInto(next, plan.mergedWatermark);
    await saveWatermark(next);
  });
}

async function applyOp(op: MergeOp): Promise<void> {
  const target = MAIN_TABLES[op.table];
  if (op.type === 'upsert' && op.record) {
    await target.put(op.record as never);
    if (op.clearTombstone) {
      await db.tombstones.delete(`${op.table}:${op.entityId}`);
    }
  } else if (op.type === 'delete' && op.tombstone) {
    await target.delete(op.entityId);
    await db.tombstones.put(op.tombstone);
  } else if (op.type === 'tombstone' && op.tombstone) {
    const existing = await db.tombstones.get(op.tombstone.id);
    if (!existing) {
      await db.tombstones.put(op.tombstone);
    }
  }
}

// ---------------------------------------------------------------------------
// 写入失败后的重试与旧表保护
// ---------------------------------------------------------------------------

export interface BackupMeta extends MergeRunInfo {
  statusNote?: string;
  finishedAt?: string;
}

export async function getBackupMeta(): Promise<BackupMeta | undefined> {
  const raw = await getMeta(BACKUP_META_KEY);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as BackupMeta;
  } catch {
    return undefined;
  }
}

/** 用保留的四张备份表恢复合并前数据（失败重试放弃，或成功后回滚） */
export async function restoreFromBackup(): Promise<void> {
  const meta = await getBackupMeta();
  if (!meta) throw new SyncPackageError('没有可恢复的合并备份');
  await db.transaction(
    'rw',
    [db.holes, db.runs, db.boxes, db.lithos, db.holesBackup, db.runsBackup, db.boxesBackup, db.lithosBackup, db.meta],
    async () => {
      for (const t of ENTITY_TABLES) {
        await MAIN_TABLES[t].clear();
        const rows = await BACKUP_TABLES[t].toArray();
        if (rows.length) await (MAIN_TABLES[t] as { bulkPut: (rows: unknown[]) => Promise<unknown> }).bulkPut(rows);
      }
      await db.meta.delete(BACKUP_META_KEY);
    },
  );
}

/** 合并确认无误后清掉四张备份表（之后不可再回滚此次合并） */
export async function discardBackup(): Promise<void> {
  await db.transaction('rw', [db.holesBackup, db.runsBackup, db.boxesBackup, db.lithosBackup, db.meta], async () => {
    await Promise.all(ENTITY_TABLES.map((t) => BACKUP_TABLES[t].clear()));
    await db.meta.delete(BACKUP_META_KEY);
  });
}

// ---------------------------------------------------------------------------
// 待处理区：编录员逐项选定版本（选定后该对象即成为本机一次改动）
// ---------------------------------------------------------------------------

export async function listPending(): Promise<PendingItem[]> {
  const items = await db.pending.toArray();
  return items.sort((a, b) => a.table.localeCompare(b.table) || a.entityId.localeCompare(b.entityId));
}

export type ResolutionChoice = 'local' | 'remote';

/** 选定版本落库：加盖本机节点的新版本向量，删除待处理项 */
export async function resolvePending(itemId: string, choice: ResolutionChoice): Promise<void> {
  const nodeId = await getNodeId();
  await db.transaction('rw', [db.holes, db.runs, db.boxes, db.lithos, db.tombstones, db.pending, db.meta], async () => {
    const item = await db.pending.get(itemId);
    if (!item) return;
    const target = MAIN_TABLES[item.table];
    const current = (await target.get(item.entityId)) as AnyRow | undefined;
    const currentTomb = await db.tombstones.get(item.id);

    if (choice === 'remote') {
      if (item.remoteDeleted) {
        // 选定对方删除
        const envelope = nextEnvelope(current ?? currentTomb, nodeId);
        await target.delete(item.entityId);
        await db.tombstones.put({ id: item.id, table: item.table, entityId: item.entityId, ...envelope });
        await advanceWatermark(envelope.vv);
      } else {
        const remote = item.remote as Partial<AnyRow> | undefined;
        if (remote && remote.nodeId && remote.vv) {
          // 在对方版本向量上加盖本机裁决版本（保留对方节点那一维）
          const envelope = nextEnvelope(remote as AnyRow, nodeId);
          const { nodeId: _n, vv: _v, baseVv: _b, updatedAt: _u, legacy: _l, ...body } = remote as AnyRow;
          void _n; void _v; void _b; void _u; void _l;
          const row = { ...body, id: item.entityId, ...envelope } as AnyRow;
          await target.put(row as never);
          await db.tombstones.delete(item.id);
          await advanceWatermark(envelope.vv);
        }
      }
    } else {
      // 选定本地：当前在库行/墓碑保留，但仍盖一次本机版本，明确「编录员已裁决」
      const base = current ?? currentTomb;
      if (base) {
        const envelope = nextEnvelope(base, nodeId);
        if (current) {
          await target.put({ ...current, ...envelope } as never);
        } else {
          await db.tombstones.put({ id: item.id, table: item.table, entityId: item.entityId, ...envelope });
        }
        await advanceWatermark(envelope.vv);
      }
    }
    await db.pending.delete(itemId);
  });
}

/** 丢弃待处理项（不改动业务数据；谨慎操作入口） */
export async function dismissPending(itemId: string): Promise<void> {
  await db.pending.delete(itemId);
}
