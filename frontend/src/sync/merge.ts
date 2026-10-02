import { rangesOverlap } from '../utils/recovery';
import {
  compareVv,
  ensureEnvelope,
  envelopeOf,
  normVv,
} from './clock';
import {
  ENTITY_TABLES,
  PROTECTED_FIELDS,
  type EntityTable,
  type MergeOp,
  type MergePlan,
  type PendingItem,
  type SyncPackage,
  type Tombstone,
  type VersionVector,
} from './types';

type Row = Record<string, unknown>;

interface LocalState {
  holes: Row[];
  runs: Row[];
  boxes: Row[];
  lithos: Row[];
  tombstones: Tombstone[];
}

interface RowDecision {
  kind: 'identical' | 'keep' | 'upsert' | 'pending' | 'delete';
  reason?: PendingItem['reason'];
  protectedFields?: string[];
  /** 对方侧是否为墓碑（remote-deleted/protected 且由删除触发时） */
  remoteDeleted?: boolean;
  /** 本地侧是否为墓碑（对方改、本地删时） */
  localDeleted?: boolean;
  /** 待处理项中对方记录（默认取导入记录；删除时为 null） */
  remoteForPending: Row | null;
}

/** 本地已确认的受保护事实字段（列出将被导入动作改动/丢失的受保护字段） */
function changedProtectedFields(table: EntityTable, local: Row, remote: Row | null): string[] {
  return PROTECTED_FIELDS[table].filter((f) => {
    // 钻孔：终孔事实（终孔深度 > 0 或有终孔日期）经本地确认
    if (f === 'finalDepth' && !(Number(local.finalDepth) > 0)) return false;
    if (f === 'endDate' && !local.endDate) return false;
    // 岩性：样品事实（样品号非空）经本地确认
    if (f === 'sampleNo' && !String(local.sampleNo ?? '').trim()) return false;
    if (remote === null) return true; // 对方删除 → 受保护事实将丢失
    return JSON.stringify(local[f]) !== JSON.stringify(remote[f]);
  });
}

function tombstoneOf(tombstones: Tombstone[], table: EntityTable, entityId: string): Tombstone | undefined {
  return tombstones.find((t) => t.table === table && t.entityId === entityId);
}

/** 同批自动合并结果内是否会生成重复箱号或重叠岩性区间 */
function findDuplicate(table: EntityTable, candidate: Row, committed: Map<string, Row>): { of: string; message: string } | undefined {
  for (const [otherId, other] of committed) {
    if (otherId === String(candidate.id)) continue;
    if (table === 'boxes') {
      if (candidate.boxNo && other.boxNo === candidate.boxNo) {
        return { of: otherId, message: `箱号 ${candidate.boxNo} 已被本地岩芯箱占用` };
      }
    } else if (
      table === 'lithos' &&
      other.holeId === candidate.holeId &&
      rangesOverlap(Number(candidate.fromDepth), Number(candidate.toDepth), Number(other.fromDepth), Number(other.toDepth))
    ) {
      return {
        of: otherId,
        message: `深度区间 ${candidate.fromDepth}~${candidate.toDepth}m 与本地岩性区间 ${other.fromDepth}~${other.toDepth}m 重叠`,
      };
    }
  }
  return undefined;
}

function makePending(
  decision: RowDecision,
  table: EntityTable,
  entityId: string,
  local: Row | undefined,
): PendingItem {
  const localEnv = local ? envelopeOf(local) : undefined;
  const remoteRow = decision.remoteForPending ?? undefined;
  const remoteEnv = remoteRow ? envelopeOf(remoteRow) : undefined;
  return {
    id: `${table}:${entityId}`,
    table,
    entityId,
    reason: decision.reason ?? 'diverged',
    protectedFields: decision.protectedFields,
    // 待处理区保留完整对方行（含信封）：编录员裁决采用对方时，要在对方版本向量上继续加盖，
    // 不能丢掉对方节点那一维，否则下一次对账会误判。
    local: local,
    remote: remoteRow,
    localNodeId: localEnv?.nodeId,
    remoteNodeId: remoteEnv?.nodeId,
    localDeleted: Boolean(decision.localDeleted) && !local,
    remoteDeleted: Boolean(decision.remoteDeleted),
    detectedAt: new Date().toISOString(),
  };
}

/**
 * 离线差量对账（纯函数）：按钻孔 → 回次 → 岩芯箱 → 岩性逐项对账。
 *
 * 版本向量结论：
 * - 仅对方改过：自动快进；但命中本地已确认的终孔/样品事实时转待处理
 * - 仅本地改过：保留本地
 * - 两边都改过：进待处理区，由编录员选定版本（不自动合并，也不参与其他对象的自动合并）
 * - 删除带墓碑按版本向量对账，本地确认事实受同样保护
 *
 * 返回的 MergePlan 只描述要做什么；写入由 syncDb 在一个整包事务里执行，失败可整包重试。
 */
export function planMerge(pack: SyncPackage, local: LocalState): MergePlan {
  const ops: MergeOp[] = [];
  const pending: PendingItem[] = [];
  const missingBaseline: string[] = [];

  const stats = { incoming: 0, identical: 0, remoteNew: 0, remoteUpdate: 0, localDelete: 0, pending: 0 };

  const localRows: Record<EntityTable, Map<string, Row>> = {
    holes: new Map(local.holes.map((r) => [String(r.id), r])),
    runs: new Map(local.runs.map((r) => [String(r.id), r])),
    boxes: new Map(local.boxes.map((r) => [String(r.id), r])),
    lithos: new Map(local.lithos.map((r) => [String(r.id), r])),
  };
  let tombstones = [...local.tombstones];
  const decisions = new Map<string, RowDecision>();

  const incomingByTable: Record<EntityTable, Row[]> = {
    holes: pack.holes.map((r) => ({ ...r })),
    runs: pack.runs.map((r) => ({ ...r })),
    boxes: pack.boxes.map((r) => ({ ...r })),
    lithos: pack.lithos.map((r) => ({ ...r })),
  };

  // ---- 第一遍：导入记录按版本向量逐项定性（不做重复校验） ----
  ENTITY_TABLES.forEach((table) => {
    incomingByTable[table].forEach((raw) => {
      stats.incoming += 1;
      const remote = ensureEnvelope(raw) as Row;
      const entityId = String(remote.id);
      const key = `${table}:${entityId}`;
      const localRow = localRows[table].get(entityId);
      const localTomb = tombstoneOf(tombstones, table, entityId);
      const remoteVv = normVv(remote.vv as VersionVector);
      const remoteBase = normVv(remote.baseVv as VersionVector);

      if (localRow) {
        const localVv = normVv(envelopeOf(localRow)!.vv);
        const order = compareVv(localVv, remoteVv);

        // 对方改动所基于的祖先版本本库从未见过：基线对不上，提示双方可能并非从同一份库分别录
        if (Object.keys(remoteBase).length > 0 && compareVv(localVv, remoteBase) === 'diverged') {
          missingBaseline.push(key);
        }

        if (order === 'equal') {
          decisions.set(key, { kind: 'identical', remoteForPending: remote });
        } else if (order === 'descendant') {
          decisions.set(key, { kind: 'keep', remoteForPending: remote });
        } else if (order === 'ancestor') {
          // 仅对方改过：本地已确认的终孔/样品事实不能被自动覆盖
          const protectedFields = changedProtectedFields(table, localRow, remote);
          decisions.set(
            key,
            protectedFields.length
              ? { kind: 'pending', reason: 'protected', protectedFields, remoteForPending: remote }
              : { kind: 'upsert', remoteForPending: remote },
          );
        } else {
          // 两边都改过
          decisions.set(key, {
            kind: 'pending',
            reason: 'diverged',
            protectedFields: changedProtectedFields(table, localRow, remote),
            remoteForPending: remote,
          });
        }
        return;
      }

      if (localTomb) {
        const order = compareVv(normVv(localTomb.vv), remoteVv);
        if (order === 'descendant' || order === 'equal') {
          decisions.set(key, { kind: 'keep', remoteForPending: remote });
        } else if (order === 'ancestor') {
          decisions.set(key, { kind: 'upsert', localDeleted: true, remoteForPending: remote }); // 删除后对方又编辑：复活
        } else {
          decisions.set(key, { kind: 'pending', reason: 'remote-deleted', localDeleted: true, remoteForPending: remote });
        }
        return;
      }

      // 本地完全没有：对方新建
      decisions.set(key, { kind: 'upsert', remoteForPending: remote });
    });
  });

  // ---- 导入墓碑逐项定性 ----
  const tombstoneWrites: Tombstone[] = [];
  pack.tombstones.forEach((rawTomb) => {
    const tomb: Tombstone = { ...rawTomb, vv: normVv(rawTomb.vv), baseVv: normVv(rawTomb.baseVv) };
    const { table, entityId } = tomb;
    const key = `${table}:${entityId}`;
    const localRow = localRows[table].get(entityId);
    const localTomb = tombstoneOf(tombstones, table, entityId);

    if (localRow) {
      const order = compareVv(normVv(envelopeOf(localRow)!.vv), tomb.vv);
      if (order === 'ancestor' || order === 'equal') {
        const protectedFields = changedProtectedFields(table, localRow, null);
        decisions.set(
          key,
          protectedFields.length
            ? { kind: 'pending', reason: 'protected', protectedFields, remoteDeleted: true, remoteForPending: null }
            : { kind: 'delete', remoteDeleted: true, remoteForPending: null },
        );
      } else if (order === 'descendant') {
        // 本地在对方删除后又编辑：对方删除过时，保留本地
      } else {
        decisions.set(key, { kind: 'pending', reason: 'remote-deleted', remoteDeleted: true, remoteForPending: null });
      }
      return;
    }

    if (localTomb) {
      if (compareVv(localTomb.vv, tomb.vv) === 'ancestor') {
        tombstoneWrites.push(tomb);
        tombstones = tombstones.map((t) => (t.id === tomb.id ? tomb : t));
      }
      return;
    }

    // 本地从未有过：记录墓碑，防止以后从第三个节点把旧数据复活
    tombstoneWrites.push(tomb);
    tombstones.push(tomb);
  });

  // ---- 第二遍：自动采用项做同批重复校验，生成 ops / pending ----
  // 待处理项与将删除对象不参与重复校验（删除会释放箱号/岩性区间）。
  const incomingKeys = new Set<string>();
  const committed: Record<EntityTable, Map<string, Row>> = {
    holes: new Map(),
    runs: new Map(),
    boxes: new Map(),
    lithos: new Map(),
  };
  ENTITY_TABLES.forEach((table) => {
    incomingByTable[table].forEach((r) => incomingKeys.add(`${table}:${String(r.id)}`));
    localRows[table].forEach((row, id) => {
      const decision = decisions.get(`${table}:${id}`);
      if (!decision || (decision.kind !== 'delete' && decision.kind !== 'pending')) {
        committed[table].set(id, row);
      }
    });
  });

  ENTITY_TABLES.forEach((table) => {
    incomingByTable[table].forEach((raw) => {
      const entityId = String(raw.id);
      const key = `${table}:${entityId}`;
      const decision = decisions.get(key);
      if (!decision) return;
      const localRow = localRows[table].get(entityId);
      const localTomb = tombstoneOf(tombstones, table, entityId);

      if (decision.kind === 'identical') {
        stats.identical += 1;
        return;
      }
      if (decision.kind === 'keep' || decision.kind === 'delete') return;

      if (decision.kind === 'pending') {
        pending.push(makePending(decision, table, entityId, localRow));
        stats.pending += 1;
        return;
      }

      // upsert：重复箱号 / 重叠岩性区间 → 转待处理，由编录员处理，避免重复生成
      const duplicate = table === 'boxes' || table === 'lithos' ? findDuplicate(table, raw, committed[table]) : undefined;
      if (duplicate) {
        pending.push({
          ...makePending({ ...decision, reason: 'duplicate', remoteForPending: raw }, table, entityId, localRow),
          duplicateOf: duplicate.of,
          duplicateMessage: duplicate.message,
        });
        stats.pending += 1;
        return;
      }

      committed[table].set(entityId, raw);
      const isResurrect = Boolean(localTomb) && !localRow;
      const verdict: MergeOp['verdict'] = !localRow ? 'remote-new' : 'remote-update';
      ops.push({
        type: 'upsert',
        table,
        entityId,
        record: raw,
        verdict,
        ...(isResurrect ? { clearTombstone: true } : {}),
      });
      if (verdict === 'remote-new') stats.remoteNew += 1;
      else stats.remoteUpdate += 1;
    });
  });

  // 仅由对方墓碑产生的待处理（包内没有该对象的记录行：对方删除 vs 本地已确认事实/本地改动）
  decisions.forEach((decision, key) => {
    if (decision.kind !== 'pending' || incomingKeys.has(key)) return;
    const [table, entityId] = key.split(':') as [EntityTable, string];
    pending.push(makePending(decision, table, entityId, localRows[table].get(entityId)));
    stats.pending += 1;
  });

  // 删除动作（对方删除且无保护冲突）
  decisions.forEach((decision, key) => {
    if (decision.kind !== 'delete') return;
    const [table, entityId] = key.split(':') as [EntityTable, string];
    const tomb = pack.tombstones.find((t) => t.table === table && t.entityId === entityId);
    if (tomb) {
      ops.push({ type: 'delete', table, entityId, tombstone: tomb, verdict: 'local-delete' });
      stats.localDelete += 1;
      if (!tombstoneWrites.some((t) => t.id === tomb.id)) tombstoneWrites.push(tomb);
    }
  });

  // 纯墓碑写入（本库从未有过的对象 / 更新已有墓碑），不触碰四张业务表
  tombstoneWrites.forEach((tomb) => {
    if (!ops.some((op) => (op.type === 'delete' || op.type === 'tombstone') && op.table === tomb.table && op.entityId === tomb.entityId)) {
      ops.push({ type: 'tombstone', table: tomb.table, entityId: tomb.entityId, tombstone: tomb, verdict: 'identical' });
    }
  });

  return {
    ops,
    pending,
    mergedWatermark: normVv(pack.watermark),
    missingBaseline: [...new Set(missingBaseline)],
    stats,
  };
}
