/**
 * 离线差量合并的元数据类型。
 *
 * 每条业务记录（钻孔 / 回次 / 岩芯箱 / 岩性）都带一份「同步信封」：
 * - nodeId  ：记录来源（哪台笔记本/哪位编录员）
 * - vv      ：版本向量，记录本条数据的当前版本（基线 + 各节点改动计数）
 * - baseVv  ：上一版的版本向量（与 vv 不同的那一维即本次改动人/改动版本）
 * - updatedAt：最后改动时间（展示用，不参与对账判定）
 *
 * 删除不直接抹数据，而是写一张逻辑删除表（tombstones，墓碑），
 * 同样带版本向量，保证「我删过」的事实也能差量同步，不会被旧数据复活。
 */

/** 四张业务表名（对账按此顺序逐项进行） */
export const ENTITY_TABLES = ['holes', 'runs', 'boxes', 'lithos'] as const;
export type EntityTable = (typeof ENTITY_TABLES)[number];

/** 版本向量：{ 节点编号 -> 该节点已产生的改动序号（从 1 开始）} */
export type VersionVector = Record<string, number>;

/** 业务记录共用的同步信封（旧数据可能没有，按兼容规则回填） */
export interface SyncEnvelope {
  nodeId: string;
  vv: VersionVector;
  baseVv: VersionVector;
  updatedAt: string;
  /** 兼容标记：由旧版（无来源字段）数据回填而来 */
  legacy?: boolean;
}

/** 业务对象加盖同步信封后落库的实际行类型 */
export type StampedEntity<T> = T & SyncEnvelope;

/** 逻辑删除标记（墓碑） */
export interface Tombstone extends SyncEnvelope {
  /** 主键：表名:原记录 id */
  id: string;
  table: EntityTable;
  entityId: string;
}

/** 待处理冲突类型 */
export type PendingReason =
  | 'diverged' // 两边都改过
  | 'remote-deleted' // 对方删除、本地改过
  | 'protected' // 本地已确认事实（终孔/样品），禁止覆盖
  | 'duplicate'; // 自动写入会生成重复箱号或重叠岩性区间

/** 待处理区条目（不参与其他对象的自动合并） */
export interface PendingItem {
  /** 主键：表名:原记录 id */
  id: string;
  table: EntityTable;
  entityId: string;
  reason: PendingReason;
  /** 命中的受保护字段（protected 时） */
  protectedFields?: string[];
  /** 重复对象描述（duplicate 时：同箱号或重叠岩性区间） */
  duplicateOf?: string;
  duplicateMessage?: string;
  local?: Record<string, unknown>;
  remote?: Record<string, unknown>;
  localNodeId?: string;
  remoteNodeId?: string;
  /** 本地当前是否已是墓碑 */
  localDeleted?: boolean;
  /** 对方版本是否为墓碑 */
  remoteDeleted?: boolean;
  detectedAt: string;
}

/** 自动合并动作 */
export interface MergeOp {
  type: 'upsert' | 'delete' | 'tombstone';
  table: EntityTable;
  entityId: string;
  /** upsert 时的完整记录（含同步信封） */
  record?: Record<string, unknown>;
  /** delete/tombstone 时的墓碑（含同步信封） */
  tombstone?: Tombstone;
  /** 复活对象（本地有墓碑、对方删除后又编辑）：写入记录同时清掉旧墓碑 */
  clearTombstone?: boolean;
  /** 对账结论（统计/展示用） */
  verdict: 'remote-new' | 'remote-update' | 'local-delete' | 'identical';
}

/** 一次导入对账的结果（纯数据，不含任何 IndexedDB 操作，便于测试与重试） */
export interface MergePlan {
  ops: MergeOp[];
  pending: PendingItem[];
  /** 导入后本库对各来源节点的认知水位（取双方并集） */
  mergedWatermark: VersionVector;
  /** 差量包中出现、但本库基线无法解释其祖先版本的记录 id（提示双方可能没基于同一库分别录） */
  missingBaseline: string[];
  stats: {
    incoming: number;
    identical: number;
    remoteNew: number;
    remoteUpdate: number;
    localDelete: number;
    pending: number;
  };
}

/** 差量包包头：标明来源与基线版本 */
export interface SyncPackage {
  app: 'gbdrillcore-sync';
  kind: 'delta';
  formatVersion: 1;
  /** 导出来源节点 */
  nodeId: string;
  /** 来源笔记本显示名（编录员/驻地可辨认） */
  nodeName?: string;
  exportedAt: string;
  schemaVersion: number;
  /** 来源节点导出时的全局认知水位 */
  watermark: VersionVector;
  /** 导出方按接收方上次水位裁剪差量；全量时为 null */
  since: VersionVector | null;
  targetNodeId?: string;
  holes: Record<string, unknown>[];
  runs: Record<string, unknown>[];
  boxes: Record<string, unknown>[];
  lithos: Record<string, unknown>[];
  tombstones: Tombstone[];
}

/** 受保护字段：本地已确认后，导入包不得自动覆盖 */
export const PROTECTED_FIELDS: Record<EntityTable, string[]> = {
  // 钻孔终孔事实：终孔深度 + 终孔日期
  holes: ['finalDepth', 'endDate'],
  runs: [],
  boxes: [],
  // 样品事实：样品号
  lithos: ['sampleNo'],
};
