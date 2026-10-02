/**
 * 离线差量包：导出 / 解析 / 对端同步基线。
 *
 * 差量包格式（纯 JSON 文件，靠 U 盘/微信在两台编录本之间传递，无后端）：
 * {
 *   app, kind: 'gbdrillcore-delta', formatVersion,
 *   source: 发包设备 { id, name },
 *   target: 目标对端设备 id（'*' = 任意对端通用包），
 *   exportedAt, schemaVersion,
 *   baseline: 各表 id→rev（发包时所基于的对端版本，'*' 包为空基线=全量），
 *   changes:  { holes/runs/boxes/lithos: { upserts: 带 _origin 的记录, deletes: [{id}] } }
 * }
 */
import { db, getMeta, META_SYNC_PREFIX, setMeta } from './db';
import { getDeviceIdentity } from './db';
import type { SourcedRow } from './provenance';

export const DELTA_APP = 'gbdrillcore';
export const DELTA_KIND = 'gbdrillcore-delta';
export const DELTA_FORMAT_VERSION = 1;
export const ANY_PEER = '*';

export type TableKey = 'holes' | 'runs' | 'boxes' | 'lithos';
export const TABLE_KEYS: TableKey[] = ['holes', 'runs', 'boxes', 'lithos'];

export const TABLE_LABEL: Record<TableKey, string> =
  { holes: '钻孔', runs: '回次', boxes: '岩芯箱', lithos: '岩性区间' };

export interface DeleteTomb {
  id: string;
  at?: string;
}

export interface TableChanges {
  upserts: SourcedRow[];
  deletes: DeleteTomb[];
}
export type ChangeSet = Record<TableKey, TableChanges>;
export type BaselineSnapshot = Record<TableKey, Record<string, string>>;

export interface DeltaPackage {
  app: typeof DELTA_APP;
  kind: typeof DELTA_KIND;
  formatVersion: number;
  schemaVersion: number;
  source: { id: string; name: string };
  target: string;
  exportedAt: string;
  note?: string;
  /** 发包方记录的收包对端基线（id→rev）；'*' 通用包为空基线 */
  baseline: BaselineSnapshot;
  changes: ChangeSet;
}

export class DeltaFormatError extends Error {}

export interface PeerInfo {
  id: string;
  name: string;
  lastExportAt?: string;
}

function emptyBaseline(): BaselineSnapshot {
  return { holes: {}, runs: {}, boxes: {}, lithos: {} };
}

export function emptyChangeSet(): ChangeSet {
  return {
    holes: { upserts: [], deletes: [] },
    runs: { upserts: [], deletes: [] },
    boxes: { upserts: [], deletes: [] },
    lithos: { upserts: [], deletes: [] },
  };
}

function tablesOf() {
  return {
    holes: db.holes,
    runs: db.runs,
    boxes: db.boxes,
    lithos: db.lithos,
  } as const;
}

/* ---------------- 对端同步游标（meta: sync:<peerId>） ----------------
 * 保存「本机上次向该对端发包时，本机各表的 id→rev 快照」：
 *  1. 下次向该对端导出差量时，作为增量游标（新增/修改/删除都相对它判断）；
 *  2. 收到该对端差量包做三方对账时，作为包内基线之外的补充共同祖先
 *     （本机首创、又回传过来的记录，包基线里没有，但游标里有）。
 * 导入对端包成功不会覆盖该游标——游标只在本机主动发包时推进。
 */

interface CursorFile extends BaselineSnapshot {
  peerName?: string;
  updatedAt?: string;
  lastImportAt?: string;
}

async function readCursor(peerId: string): Promise<CursorFile> {
  const raw = await getMeta(`${META_SYNC_PREFIX}${peerId}`);
  if (!raw) return { ...emptyBaseline() };
  try {
    const parsed = JSON.parse(raw) as Partial<CursorFile>;
    return {
      holes: parsed.holes ?? {},
      runs: parsed.runs ?? {},
      boxes: parsed.boxes ?? {},
      lithos: parsed.lithos ?? {},
      peerName: parsed.peerName,
      updatedAt: parsed.updatedAt,
      lastImportAt: parsed.lastImportAt,
    };
  } catch {
    return { ...emptyBaseline() };
  }
}

async function writeCursor(peerId: string, cursor: CursorFile): Promise<void> {
  await setMeta(`${META_SYNC_PREFIX}${peerId}`, JSON.stringify(cursor));
}

/** 取某对端的基线快照（id→rev），供对账引擎当补充共同祖先用 */
export async function readPeerBaseline(peerId: string): Promise<BaselineSnapshot> {
  const cursor = await readCursor(peerId);
  return { holes: cursor.holes, runs: cursor.runs, boxes: cursor.boxes, lithos: cursor.lithos };
}

/** 已建立同步关系的对端清单（导出发过包 / 导入收过包都会登记） */
export async function listPeers(): Promise<PeerInfo[]> {
  const rows = await db.meta.where('key').startsWith(META_SYNC_PREFIX).toArray();
  return rows
    .map((row) => {
      const id = row.key.slice(META_SYNC_PREFIX.length);
      let name = id;
      let lastExportAt: string | undefined;
      try {
        const parsed = JSON.parse(row.value) as CursorFile;
        name = parsed.peerName || id;
        lastExportAt = parsed.updatedAt;
      } catch {
        // 忽略损坏行
      }
      return { id, name, lastExportAt };
    })
    .filter((peer) => peer.id !== ANY_PEER)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 导入成功后登记对端（若本机从未向其发过包，则留空游标 → 下次发包为全量包） */
export async function registerPeerFromImport(peer: { id: string; name: string }, importedAt: string): Promise<void> {
  const cursor = await readCursor(peer.id);
  await writeCursor(peer.id, {
    ...cursor,
    peerName: peer.name || cursor.peerName || peer.id,
    lastImportAt: importedAt,
  });
}

/* ---------------- 导出差量包 ---------------- */

export interface BuildDeltaOptions {
  /** 目标对端设备 id；缺省/'*' 导出任意对端可用的全量包 */
  target?: string;
  /** 目标对端显示名（记录进本机基线，方便下次列出） */
  targetName?: string;
  note?: string;
}

/**
 * 构建差量包：
 *  - 指定对端：只打包「自上次发给该对端基线以来」的新增/修改/删除，包内带基线版本；
 *  - 通用包（'*'）：全量 upsert、无基线，首次对接用。
 * 导出后推进本机保存的对端基线（当前库即下次的基线）。
 */
export async function buildDeltaPackage(options: BuildDeltaOptions = {}): Promise<DeltaPackage> {
  const target = options.target || ANY_PEER;
  const identity = await getDeviceIdentity();
  const prevCursor = target === ANY_PEER ? { ...emptyBaseline() } : await readCursor(target);
  const previous: BaselineSnapshot = {
    holes: prevCursor.holes,
    runs: prevCursor.runs,
    boxes: prevCursor.boxes,
    lithos: prevCursor.lithos,
  };
  const changes = emptyChangeSet();
  const nextCursor: CursorFile = { ...emptyBaseline() };
  const exportedAt = new Date().toISOString();

  for (const key of TABLE_KEYS) {
    const rows = (await tablesOf()[key].toArray()) as unknown as SourcedRow[];
    const prevRev = previous[key];
    for (const row of rows) {
      const rev = row._origin?.rev ?? '';
      nextCursor[key][row.id] = rev;
      if (target === ANY_PEER || prevRev[row.id] !== rev) {
        changes[key].upserts.push(row);
      }
    }
    // 游标里有、当前库已没有 → 自上次发包以来被本机删除
    for (const id of Object.keys(prevRev)) {
      if (!nextCursor[key][id]) {
        changes[key].deletes.push({ id, at: exportedAt });
      }
    }
  }

  const pkg: DeltaPackage = {
    app: DELTA_APP,
    kind: DELTA_KIND,
    formatVersion: DELTA_FORMAT_VERSION,
    schemaVersion: 3,
    source: { id: identity.id, name: identity.name },
    target,
    exportedAt,
    note: options.note?.trim() || undefined,
    baseline: target === ANY_PEER ? emptyBaseline() : previous,
    changes,
  };

  // 推进本机对该对端的发包游标（不覆盖 lastImportAt；对端名取最新）
  if (target !== ANY_PEER) {
    nextCursor.peerName = options.targetName?.trim() || prevCursor.peerName || target;
    nextCursor.updatedAt = exportedAt;
    nextCursor.lastImportAt = prevCursor.lastImportAt;
    await writeCursor(target, nextCursor);
  }
  return pkg;
}
/* ---------------- 解析差量包 ---------------- */

/** 解析并严格校验差量包文本；不合法直接抛 DeltaFormatError */
export function parseDeltaPackage(text: string): DeltaPackage {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DeltaFormatError('差量包不是合法 JSON 文件');
  }
  const pkg = raw as Partial<DeltaPackage>;
  if (!pkg || typeof pkg !== 'object') throw new DeltaFormatError('差量包内容为空');
  if (pkg.app !== DELTA_APP) throw new DeltaFormatError('文件标记不匹配（缺少 app=gbdrillcore）');
  if (pkg.kind !== DELTA_KIND) throw new DeltaFormatError('文件类型不是编录差量包（kind=gbdrillcore-delta）');
  if (typeof pkg.formatVersion !== 'number') throw new DeltaFormatError('差量包缺少格式版本号');
  if (pkg.formatVersion > DELTA_FORMAT_VERSION) {
    throw new DeltaFormatError(`差量包格式版本 v${pkg.formatVersion} 过新，请升级本程序后再导入`);
  }
  if (!pkg.source || typeof pkg.source.id !== 'string') throw new DeltaFormatError('差量包缺少来源设备标识');
  if (!pkg.exportedAt) throw new DeltaFormatError('差量包缺少导出时间');

  const changes = (pkg.changes ?? emptyChangeSet()) as ChangeSet;
  for (const key of TABLE_KEYS) {
    const tableChanges = changes[key];
    if (!tableChanges || !Array.isArray(tableChanges.upserts) || !Array.isArray(tableChanges.deletes)) {
      throw new DeltaFormatError(`差量包 ${TABLE_LABEL[key]} 变更段不完整`);
    }
    for (const row of tableChanges.upserts) {
      if (!row || typeof row.id !== 'string') {
        throw new DeltaFormatError(`${TABLE_LABEL[key]} 存在缺少 id 的记录`);
      }
    }
    for (const tomb of tableChanges.deletes) {
      if (!tomb || typeof tomb.id !== 'string') {
        throw new DeltaFormatError(`${TABLE_LABEL[key]} 删除清单存在缺少 id 的项`);
      }
    }
  }
  return { ...pkg, changes, baseline: pkg.baseline ?? emptyBaseline() } as DeltaPackage;
}

/** 差量包文件名 */
export function deltaFileName(pkg: DeltaPackage): string {
  const day = pkg.exportedAt.slice(0, 10);
  const target = pkg.target === ANY_PEER ? 'all' : pkg.target.slice(0, 8);
  return `gbdrillcore-delta-${pkg.source.id.slice(4, 10)}-to-${target}-${day}.json`;
}
