import type { SyncEnvelope, VersionVector } from './types';

/** 旧版数据回填时使用的公共祖先来源（升级前两台机器的同一份库） */
export const LEGACY_NODE_ID = '__legacy__';

/** 版本向量比较结果：
 * - equal      同版本
 * - ancestor   a 是 b 的祖先（b 更新）
 * - descendant a 是 b 的后代（a 更新）
 * - diverged   两边都有对方没有的改动（冲突）
 */
export type ClockOrder = 'equal' | 'ancestor' | 'descendant' | 'diverged';

export function cloneVv(vv: VersionVector): VersionVector {
  return { ...vv };
}

/** 跳过值为 0 的维度 */
export function normVv(vv: VersionVector | undefined): VersionVector {
  const out: VersionVector = {};
  if (!vv) return out;
  for (const [k, v] of Object.entries(vv)) {
    if (v > 0) out[k] = v;
  }
  return out;
}

export function vvEqual(a: VersionVector | undefined, b: VersionVector | undefined): boolean {
  const aa = normVv(a);
  const bb = normVv(b);
  const keys = new Set([...Object.keys(aa), ...Object.keys(bb)]);
  return [...keys].every((k) => (aa[k] ?? 0) === (bb[k] ?? 0));
}

/** 比较两个版本向量 */
export function compareVv(aIn: VersionVector | undefined, bIn: VersionVector | undefined): ClockOrder {
  const a = normVv(aIn);
  const b = normVv(bIn);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let aGreater = false;
  let bGreater = false;
  keys.forEach((k) => {
    const av = a[k] ?? 0;
    const bv = b[k] ?? 0;
    if (av > bv) aGreater = true;
    if (av < bv) bGreater = true;
  });
  if (!aGreater && !bGreater) return 'equal';
  if (aGreater && !bGreater) return 'descendant';
  if (!aGreater && bGreater) return 'ancestor';
  return 'diverged';
}

/** out = max(out, other)（逐维取大） */
export function mergeVvInto(out: VersionVector, other: VersionVector | undefined): void {
  if (!other) return;
  for (const [k, v] of Object.entries(normVv(other))) {
    out[k] = Math.max(out[k] ?? 0, v);
  }
}

/** 各维取大的并集版本向量 */
export function mergeVv(a: VersionVector | undefined, b: VersionVector | undefined): VersionVector {
  const out = normVv(a);
  mergeVvInto(out, b);
  return out;
}

/** a 是否严格领先于 b（至少一维更大、其余不小） */
export function vvDominates(a: VersionVector | undefined, b: VersionVector | undefined): boolean {
  return compareVv(a, b) === 'descendant';
}

/** 本节点在旧版本上产生一次改动后的信封 */
export function nextEnvelope(prev: SyncEnvelope | undefined, nodeId: string): SyncEnvelope {
  const prevVv = prev ? normVv(prev.vv) : {};
  const vv: VersionVector = { ...prevVv, [nodeId]: (prevVv[nodeId] ?? 0) + 1 };
  return {
    nodeId,
    vv,
    baseVv: prevVv,
    updatedAt: new Date().toISOString(),
  };
}

/** 新建记录的信封（祖先为空） */
export function createEnvelope(nodeId: string): SyncEnvelope {
  return nextEnvelope(undefined, nodeId);
}

/**
 * 旧数据兼容回填：缺少来源字段时按统一规则补齐。
 * 所有升级前的旧记录共享同一个公共祖先节点 __legacy__@1，
 * 这样两台从同一份旧库出发的笔记本各自改动后仍能正确识别为「都改过」，
 * 而不会把旧数据误判成两台机器各自新建。
 */
export function legacyEnvelope(updatedAt = new Date().toISOString()): SyncEnvelope {
  return {
    nodeId: LEGACY_NODE_ID,
    vv: { [LEGACY_NODE_ID]: 1 },
    baseVv: {},
    updatedAt,
    legacy: true,
  };
}

/** 记录是否带合法的同步信封；否则导入/对账时按旧数据规则回填 */
export function hasEnvelope(row: Record<string, unknown> | undefined): row is Record<string, unknown> {
  if (!row) return false;
  const e = row as unknown as Partial<SyncEnvelope>;
  return Boolean(e && typeof e.nodeId === 'string' && e.vv && typeof e.vv === 'object');
}

/** 取记录上的信封（不做回填） */
export function envelopeOf(row: Record<string, unknown>): SyncEnvelope | undefined {
  return hasEnvelope(row) ? (row as unknown as SyncEnvelope) : undefined;
}

/** 确保信封存在：缺失则按旧数据规则回填（就地修改并返回同一记录） */
export function ensureEnvelope<T extends Record<string, unknown>>(row: T): T {
  if (envelopeOf(row)) return row;
  Object.assign(row, legacyEnvelope());
  return row;
}

/** 去掉信封字段，只留业务字段（展示/比对用） */
export function stripEnvelope(row: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!row) return {};
  const { nodeId, vv, baseVv, updatedAt, legacy, ...body } = row as Record<string, unknown> & SyncEnvelope;
  void nodeId;
  void vv;
  void baseVv;
  void updatedAt;
  void legacy;
  return body;
}

/** 业务字段逐项比对（忽略信封与派生字段差异由调用方决定） */
export function bodiesEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ba = stripEnvelope(a);
  const bb = stripEnvelope(b);
  const keys = new Set([...Object.keys(ba), ...Object.keys(bb)]);
  return [...keys].every((k) => JSON.stringify(ba[k]) === JSON.stringify(bb[k]));
}

/** 字段标签（待处理区展示用） */
export const FIELD_LABELS: Record<string, string> = {
  finalDepth: '终孔深度',
  endDate: '终孔日期',
  sampleNo: '样品号',
};
