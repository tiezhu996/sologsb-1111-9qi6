/**
 * 差量包三方对账引擎（纯逻辑，不碰 IndexedDB，便于离线单测）。
 *
 * 对钻孔 / 回次 / 岩芯箱 / 岩性逐项对账，共同祖先 = 包内基线 ∪ 本机发包游标：
 *  - 只有对端改过  → 自动并入
 *  - 只有本机改过  → 保留本机
 *  - 两边都改过    → 进待处理区，由编录员选版本
 *  - 对端删除而本机改过 / 本机已确认终孔、样品 → 进待处理区，受保护事实不得覆盖
 *  - 父对象（钻孔、已冲突回次/区间）在待处理区 → 子对象不自动合并，挂起隔离
 * 待处理项不参与任何其他对象的自动合并。
 */
import { rangesOverlap } from './recovery';
import { revOf, type SourcedRow } from './provenance';
import { TABLE_KEYS, TABLE_LABEL, type BaselineSnapshot, type DeltaPackage, type TableKey } from './deltaPackage';

export type ItemStatus = 'auto' | 'pending' | 'held' | 'ignore';
export type ItemAction = 'upsert' | 'delete' | 'keep';
export type ResolutionChoice = 'keep-local' | 'take-incoming' | 'merge-incoming-nonprotected' | 'confirm-delete';

export interface ReconcileItem {
  /** 对账单内稳定编号：表:记录id */
  itemId: string;
  table: TableKey;
  status: ItemStatus;
  /** 自动合并时拟执行的动作 */
  action: ItemAction;
  /** 判定原因（界面直接展示） */
  reason: string;
  /** 包内记录 id（删除项也有） */
  incomingId: string;
  /** 落到本机后使用的 id（自然键对上时改为本机 id，避免重复生成） */
  targetId: string;
  /** 涉及本机已确认的终孔/样品事实，导入版本不得覆盖 */
  hardProtected?: boolean;
  /** 受保护字段名（界面提示用） */
  protectedFields?: string[];
  baseRev?: string;
  localRev?: string;
  incomingRev?: string;
  localRow?: SourcedRow;
  incomingRow?: SourcedRow;
  /** 两边内容不同的业务字段（中文标签） */
  changedFields?: string[];
}

export interface ReconcileResult {
  items: ReconcileItem[];
  /** 对端来源 */
  peer: { id: string; name: string };
  exportedAt: string;
  auto: number;
  pending: number;
  held: number;
  ignored: number;
}

/* ----------------------------- 业务字段标签 ----------------------------- */

export const FIELD_LABELS: Record<TableKey, Record<string, string>> = {
  holes: {
    holeNo: '孔号',
    coordX: '坐标 X',
    coordY: '坐标 Y',
    collarElevation: '孔口标高',
    designDepth: '设计孔深',
    finalDepth: '终孔深度',
    startDate: '开孔日期',
    endDate: '终孔日期',
    rigNo: '钻机号',
    shift: '班组',
    surveyData: '测斜数据',
    remark: '备注',
  },
  runs: {
    runNo: '回次号',
    fromDepth: '起深度',
    toDepth: '止深度',
    footage: '进尺',
    coreLength: '岩芯长度',
    recovery: '采取率',
    waterLevel: '回次水位',
    shift: '班次',
    drilledAt: '钻进日期',
    recorder: '记录人',
    remark: '备注',
  },
  boxes: {
    boxNo: '箱号',
    fromDepth: '起深度',
    toDepth: '止深度',
    slots: '格数',
    slotLength: '每格长度',
    boxedAt: '装箱日期',
    shelfPos: '库架位',
    damagedSlots: '破损格',
    operator: '装箱人',
    remark: '备注',
  },
  lithos: {
    fromDepth: '起深度',
    toDepth: '止深度',
    lithology: '岩性',
    color: '颜色',
    alteration: '蚀变',
    mineralization: '矿化',
    rqd: 'RQD',
    sampleNo: '样品号',
    logger: '编录人',
    remark: '备注',
  },
};

/** 不参与逐字段比对的派生/标识字段 */
const SKIP_FIELDS = new Set(['id', '_origin']);

export function fieldDiff(table: TableKey, local: SourcedRow, incoming: SourcedRow): string[] {
  const labels = FIELD_LABELS[table];
  const keys = new Set([...Object.keys(local), ...Object.keys(incoming)]);
  const diffs: string[] = [];
  for (const key of keys) {
    if (SKIP_FIELDS.has(key)) continue;
    if (JSON.stringify(local[key] ?? null) !== JSON.stringify(incoming[key] ?? null)) {
      diffs.push(labels[key] ?? key);
    }
  }
  return diffs;
}

/* ----------------------------- 受保护事实 ----------------------------- */

/** 本机已确认终孔：终孔深度 > 0 或已填终孔日期 */
export function holeConfirmed(local: SourcedRow): boolean {
  return Number(local.finalDepth) > 0 || Boolean(String(local.endDate ?? '').trim());
}

export function holeProtectedFields(local: SourcedRow, incoming: SourcedRow): string[] {
  const fields: string[] = [];
  if (holeConfirmed(local)) {
    if (Number(incoming.finalDepth ?? 0) !== Number(local.finalDepth ?? 0)) fields.push('终孔深度');
    if (String(incoming.endDate ?? '') !== String(local.endDate ?? '')) fields.push('终孔日期');
  }
  return fields;
}

/** 本机已登记的样品号即确认事实：样品号非空且导入值不同 */
export function lithoProtectedFields(local: SourcedRow, incoming: SourcedRow): string[] {
  const localSample = String(local.sampleNo ?? '').trim();
  if (localSample && String(incoming.sampleNo ?? '').trim() !== localSample) {
    return ['样品号'];
  }
  return [];
}

/* ----------------------------- 对象标题 ----------------------------- */

export function rowTitle(table: TableKey, row?: SourcedRow): string {
  if (!row) return '（缺失）';
  if (table === 'holes') return `钻孔 ${String(row.holeNo ?? row.id)}`;
  if (table === 'runs') return `回次 ${String(row.runNo ?? row.id)}（${Number(row.fromDepth)}~${Number(row.toDepth)}m）`;
  if (table === 'boxes') return `岩芯箱 ${String(row.boxNo ?? row.id)}（${Number(row.fromDepth)}~${Number(row.toDepth)}m）`;
  return `岩性区间 ${Number(row.fromDepth)}~${Number(row.toDepth)}m`;
}

/* ----------------------------- 对账主体 ----------------------------- */

interface ReconcileContext {
  /** incoming 钻孔 id → 本机目标 id（同对象时是本机 id，新孔时保持原 id） */
  holeIdMap: Map<string, string>;
  /** 待处理/挂起钻孔（目标 id）：其下子对象一律挂起隔离 */
  pendingHoleIds: Set<string>;
  /** 本包确定自动删除的钻孔（目标 id）：子记录墓碑照常执行，子记录新增视为包不一致挂起 */
  deletedHoleIds: Set<string>;
  /** 待处理/挂起回次的同孔深度区间，供岩芯箱、岩性的新增做隔离 */
  heldRunRanges: Array<{ holeId: string; from: number; to: number }>;
  /** 待处理/挂起箱键：holeId + '|' + boxNo */
  heldBoxKeys: Set<string>;
  /** 待处理/挂起岩芯箱区间，同孔同箱号/同深度后续不自动合并 */
  heldBoxRanges: Array<{ holeId: string; from: number; to: number }>;
  /** 待处理/挂起岩性区间，后续岩性新增/重叠不自动合并 */
  heldLithoRanges: Array<{ holeId: string; from: number; to: number }>;
  /** 待处理/挂起回次键：holeId + '|' + runNo */
  heldRunKeys: Set<string>;
}

type LocalTables = Record<TableKey, SourcedRow[]>;

function num(value: unknown): number {
  return Number(value) || 0;
}

/** 三方判定一条「两边都在」的记录 */
function classifyExisting(params: {
  table: TableKey;
  local: SourcedRow;
  incoming: SourcedRow;
  baseRev?: string;
  targetId: string;
  /** 是否通过自然键（孔号/回次号/箱号/深度区间）而非同一 id 对上的 */
  matchedByNaturalKey?: boolean;
}): ReconcileItem {
  const { table, local, incoming, targetId } = params;
  const localRev = revOf(local);
  const incomingRev = revOf(incoming);
  const itemId = `${table}:${incoming.id}`;
  const changedFields = fieldDiff(table, local, incoming);

  const protectedFields =
    table === 'holes'
      ? holeProtectedFields(local, incoming)
      : table === 'lithos'
        ? lithoProtectedFields(local, incoming)
        : [];

  // 自然键对上但无共同祖先：即便内容一致，也是两边独立生成的同一业务对象，必须人工确认，避免重复对象被静默合并
  if (params.matchedByNaturalKey && !params.baseRev) {
    const hard = protectedFields.length > 0;
    return {
      itemId,
      table,
      status: 'pending',
      action: 'keep',
      reason:
        changedFields.length === 0
          ? `两边各自生成了相同的${TABLE_LABEL[table]}（无共同基线版本），请确认是否同一对象，避免重复`
          : `两边都新建了${TABLE_LABEL[table]}且无共同基线版本，字段：${changedFields.join('、')}`,
      incomingId: incoming.id,
      targetId,
      hardProtected: hard,
      protectedFields: hard ? protectedFields : undefined,
      localRev,
      incomingRev,
      localRow: local,
      incomingRow: incoming,
      changedFields,
    };
  }

  // 同一 id 且两边最终内容一致：无需动作
  if (localRev === incomingRev || changedFields.length === 0) {
    return {
      itemId,
      table,
      status: 'ignore',
      action: 'keep',
      reason: '两边内容一致',
      incomingId: incoming.id,
      targetId,
      baseRev: params.baseRev,
      localRev,
      incomingRev,
      localRow: local,
      incomingRow: incoming,
    };
  }
  const localChanged = localRev !== params.baseRev;
  const incomingChanged = incomingRev !== params.baseRev;

  if (!localChanged && !incomingChanged) {
    // 基线相同但两边互异（理论上不会出现），保守挂起
    return {
      itemId,
      table,
      status: 'pending',
      action: 'keep',
      reason: '修订号异常，需人工核对',
      incomingId: incoming.id,
      targetId,
      baseRev: params.baseRev,
      localRev,
      incomingRev,
      localRow: local,
      incomingRow: incoming,
      changedFields,
    };
  }

  // 只有对端改过：拟自动并入；但本机已确认的终孔/样品事实不得覆盖
  if (incomingChanged && !localChanged) {
    if (protectedFields.length > 0) {
      return {
        itemId,
        table,
        status: 'pending',
        action: 'keep',
        reason: `导入包试图改动本机已确认的${protectedFields.join('、')}，已锁定待人工处理`,
        incomingId: incoming.id,
        targetId,
        hardProtected: true,
        protectedFields,
        baseRev: params.baseRev,
        localRev,
        incomingRev,
        localRow: local,
        incomingRow: incoming,
        changedFields,
      };
    }
    return {
      itemId,
      table,
      status: 'auto',
      action: 'upsert',
      reason: `对端修改（${changedFields.join('、')}），本机未改，自动并入`,
      incomingId: incoming.id,
      targetId,
      baseRev: params.baseRev,
      localRev,
      incomingRev,
      localRow: local,
      incomingRow: incoming,
      changedFields,
    };
  }

  // 只有本机改过：保留本机
  if (localChanged && !incomingChanged) {
    return {
      itemId,
      table,
      status: 'ignore',
      action: 'keep',
      reason: `仅本机修改过（${changedFields.join('、')}），保留本机版本`,
      incomingId: incoming.id,
      targetId,
      baseRev: params.baseRev,
      localRev,
      incomingRev,
      localRow: local,
      incomingRow: incoming,
      changedFields,
    };
  }

  // 两边都改过：进待处理区
  return {
    itemId,
    table,
    status: 'pending',
    action: 'keep',
    reason: `两边都修改过（${changedFields.join('、')}），请选定保留版本`,
    incomingId: incoming.id,
    targetId,
    hardProtected: protectedFields.length > 0,
    protectedFields: protectedFields.length ? protectedFields : undefined,
    baseRev: params.baseRev,
    localRev,
    incomingRev,
    localRow: local,
    incomingRow: incoming,
    changedFields,
  };
}

function overlapsAny(
  ranges: Array<{ holeId: string; from: number; to: number }>,
  holeId: string,
  from: number,
  to: number,
): boolean {
  return ranges.some((r) => r.holeId === holeId && rangesOverlap(r.from, r.to, from, to));
}

/**
 * 执行对账。
 * @param pkg   已解析的差量包
 * @param local 本机四张表当前数据
 * @param localCursor 本机保存的对该对端发包游标（包基线之外的补充共同祖先）
 */
export function reconcile(pkg: DeltaPackage, local: LocalTables, localCursor: BaselineSnapshot): ReconcileResult {
  const items: ReconcileItem[] = [];
  const ctx: ReconcileContext = {
    holeIdMap: new Map(),
    pendingHoleIds: new Set(),
    deletedHoleIds: new Set(),
    heldRunRanges: [],
    heldRunKeys: new Set(),
    heldBoxKeys: new Set(),
    heldBoxRanges: [],
    heldLithoRanges: [],
  };

  const baseRevFor = (table: TableKey, id: string): string | undefined =>
    pkg.baseline[table]?.[id] ?? localCursor[table]?.[id];

  /* ============ 钻孔（先对账，决定 holeId 映射与挂起集合） ============ */
  reconcileHoles(pkg, local, baseRevFor, items, ctx);

  /* ============ 回次 ============ */
  reconcileRuns(pkg, local, baseRevFor, items, ctx);

  /* ============ 岩芯箱 ============ */
  reconcileBoxes(pkg, local, baseRevFor, items, ctx);

  /* ============ 岩性区间 ============ */
  reconcileLithos(pkg, local, baseRevFor, items, ctx);

  const count = (status: ItemStatus) => items.filter((item) => item.status === status).length;
  return {
    items,
    peer: { id: pkg.source.id, name: pkg.source.name },
    exportedAt: pkg.exportedAt,
    auto: count('auto'),
    pending: count('pending'),
    held: count('held'),
    ignored: count('ignore'),
  };
}

/* ------------------------------ 钻孔 ------------------------------ */

function reconcileHoles(
  pkg: DeltaPackage,
  local: LocalTables,
  baseRevFor: (table: TableKey, id: string) => string | undefined,
  items: ReconcileItem[],
  ctx: ReconcileContext,
): void {
  const key = 'holes';
  const localRows = local.holes;
  const incomingRows = pkg.changes.holes.upserts;
  const usedLocal = new Set<string>();

  // 包内孔号自撞：两台机器各自新建了同孔号的包内记录（极少，直接挂起）
  const seenHoleNo = new Map<string, string>();
  const pkgDupIds = new Set<string>();
  for (const row of incomingRows) {
    const no = String(row.holeNo ?? '').trim();
    const prev = seenHoleNo.get(no);
    if (prev) {
      pkgDupIds.add(row.id);
      pkgDupIds.add(prev);
    } else {
      seenHoleNo.set(no, row.id);
    }
  }

  for (const incoming of incomingRows) {
    let matched = localRows.find((row) => row.id === incoming.id);
    let matchedByNaturalKey = false;
    if (matched) usedLocal.add(matched.id);

    // 自然键：同孔号（两台机器分开录，id 不同但同一钻孔）
    if (!matched) {
      const no = String(incoming.holeNo ?? '').trim();
      matched = localRows.find((row) => !usedLocal.has(row.id) && String(row.holeNo ?? '').trim() === no);
      if (matched) {
        usedLocal.add(matched.id);
        matchedByNaturalKey = true;
      }
    }

    const targetId = matched ? matched.id : incoming.id;
    ctx.holeIdMap.set(incoming.id, targetId);

    if (!matched) {
      if (pkgDupIds.has(incoming.id)) {
        items.push({
          itemId: `${key}:${incoming.id}`,
          table: key,
          status: 'held',
          action: 'keep',
          reason: '差量包内存在两个相同孔号的新钻孔，需人工核对后再并',
          incomingId: incoming.id,
          targetId,
          incomingRow: incoming,
        });
        ctx.pendingHoleIds.add(targetId);
      } else {
        items.push({
          itemId: `${key}:${incoming.id}`,
          table: key,
          status: 'auto',
          action: 'upsert',
          reason: '本机没有的新钻孔，自动并入',
          incomingId: incoming.id,
          targetId,
          baseRev: baseRevFor(key, incoming.id),
          incomingRev: revOf(incoming),
          incomingRow: incoming,
        });
      }
      continue;
    }

    const item = classifyExisting({
      table: key,
      local: matched,
      incoming,
      baseRev: baseRevFor(key, incoming.id),
      targetId,
      matchedByNaturalKey,
    });
    items.push(item);
    if (item.status === 'pending' || item.status === 'held') {
      ctx.pendingHoleIds.add(targetId);
    }
  }

  // 删除墓碑
  for (const tomb of pkg.changes.holes.deletes) {
    const localRow = localRows.find((row) => row.id === tomb.id);
    const itemId = `${key}:${tomb.id}`;
    if (!localRow) {
      items.push({ itemId, table: key, status: 'ignore', action: 'keep', reason: '本机已无该钻孔', incomingId: tomb.id, targetId: tomb.id });
      continue;
    }
    const baseRev = baseRevFor(key, tomb.id);
    const localRev = revOf(localRow);
    if (holeConfirmed(localRow)) {
      items.push({
        itemId,
        table: key,
        status: 'pending',
        action: 'keep',
        reason: '对端要求删除该钻孔，但本机已确认终孔，终孔事实不得删除，请人工处理',
        incomingId: tomb.id,
        targetId: tomb.id,
        hardProtected: true,
        protectedFields: ['终孔深度', '终孔日期'],
        baseRev,
        localRev,
        localRow,
      });
      ctx.pendingHoleIds.add(localRow.id);
      continue;
    }
    if (baseRev && localRev === baseRev && holeDeleteSafe(pkg, ctx, localRow.id, local)) {
      items.push({ itemId, table: key, status: 'auto', action: 'delete', reason: '对端删除且本机未改，孔下回次/岩芯箱/岩性均在同包删除，自动整孔删除', incomingId: tomb.id, targetId: tomb.id, baseRev, localRev, localRow });
      // 该孔确定删除：子记录墓碑可执行，子记录新增视为包不一致挂起
      ctx.deletedHoleIds.add(localRow.id);
    } else {
      const reason =
        !holeDeleteSafe(pkg, ctx, localRow.id, local)
          ? '对端删除钻孔，但孔下尚有未在同包删除的回次/岩芯箱/岩性，需先处理子记录'
          : baseRev
            ? '对端删除但本机在基线之后改过该钻孔，请确认'
            : '对端删除的钻孔缺少共同基线，本机记录需人工确认';
      items.push({
        itemId,
        table: key,
        status: 'pending',
        action: 'keep',
        reason,
        incomingId: tomb.id,
        targetId: tomb.id,
        baseRev,
        localRev,
        localRow,
      });
      ctx.pendingHoleIds.add(localRow.id);
    }
  }
}

/**
 * 整孔自动删除的安全条件：孔下本机尚存的回次/岩芯箱/岩性，
 * 必须全部出现在同包删除清单里，且包里没有还指向该孔的子记录新增，否则会产生孤儿数据。
 */
function holeDeleteSafe(pkg: DeltaPackage, ctx: ReconcileContext, holeId: string, local: LocalTables): boolean {
  const check = (table: TableKey, rows: SourcedRow[]) => {
    const children = rows.filter((row) => String(row.holeId) === holeId);
    const tombs = new Set(pkg.changes[table].deletes.map((tomb) => tomb.id));
    for (const child of children) {
      if (!tombs.has(child.id)) return false;
    }
    for (const upsert of pkg.changes[table].upserts) {
      if (mapHoleId(ctx, upsert.holeId) === holeId) return false;
    }
    return true;
  };
  return check('runs', local.runs) && check('boxes', local.boxes) && check('lithos', local.lithos);
}

/* ------------------------------ 回次 ------------------------------ */

function mapHoleId(ctx: ReconcileContext, rawHoleId: unknown): string {
  const id = String(rawHoleId ?? '');
  return ctx.holeIdMap.get(id) ?? id;
}

function reconcileRuns(
  pkg: DeltaPackage,
  local: LocalTables,
  baseRevFor: (table: TableKey, id: string) => string | undefined,
  items: ReconcileItem[],
  ctx: ReconcileContext,
): void {
  const key = 'runs';
  const localRows = local.runs;
  const incomingRows = pkg.changes[key].upserts;
  const usedLocal = new Set<string>();

  // 包内同孔同回次号自撞
  const pkgRunKeys = new Map<string, string>();
  const pkgDupIds = new Set<string>();
  for (const row of incomingRows) {
    const k = `${mapHoleId(ctx, row.holeId)}|${String(row.runNo ?? '').trim()}`;
    const prev = pkgRunKeys.get(k);
    if (prev) {
      pkgDupIds.add(row.id);
      pkgDupIds.add(prev);
    } else {
      pkgRunKeys.set(k, row.id);
    }
  }

  for (const incomingRaw of incomingRows) {
    const incoming: SourcedRow = { ...incomingRaw, holeId: mapHoleId(ctx, incomingRaw.holeId) };
    const holeId = String(incoming.holeId);

    // 父钻孔在待处理区：子对象挂起隔离
    if (ctx.pendingHoleIds.has(holeId) || ctx.deletedHoleIds.has(holeId)) {
      const reason = ctx.deletedHoleIds.has(holeId)
        ? '所属钻孔在同包内被整孔删除，回次新增不并入（如确需保留请先保留钻孔）'
        : '所属钻孔还在待处理区，回次暂不自动合并';
      items.push({
        itemId: `${key}:${incomingRaw.id}`,
        table: key,
        status: 'held',
        action: 'keep',
        reason,
        incomingId: incomingRaw.id,
        targetId: incomingRaw.id,
        incomingRow: incoming,
      });
      ctx.heldRunKeys.add(`${holeId}|${String(incoming.runNo ?? '').trim()}`);
      ctx.heldRunRanges.push({ holeId, from: num(incoming.fromDepth), to: num(incoming.toDepth) });
      continue;
    }

    let matched = localRows.find((row) => row.id === incomingRaw.id);
    let matchedByNaturalKey = false;
    if (matched) usedLocal.add(matched.id);
    if (!matched) {
      matched = localRows.find(
        (row) => !usedLocal.has(row.id) && String(row.holeId) === holeId && String(row.runNo ?? '').trim() === String(incoming.runNo ?? '').trim(),
      );
      if (matched) {
        usedLocal.add(matched.id);
        matchedByNaturalKey = true;
      }
    }
    // 同孔深度区间重叠也视为同一回次（防止两台机器重复生成同段回次）
    if (!matched) {
      matched = localRows.find(
        (row) =>
          !usedLocal.has(row.id) &&
          String(row.holeId) === holeId &&
          rangesOverlap(num(row.fromDepth), num(row.toDepth), num(incoming.fromDepth), num(incoming.toDepth)),
      );
      if (matched) {
        usedLocal.add(matched.id);
        matchedByNaturalKey = true;
      }
    }

    const targetId = matched ? matched.id : incomingRaw.id;
    const runKey = `${holeId}|${String(incoming.runNo ?? '').trim()}`;

    if (!matched) {
      if (pkgDupIds.has(incomingRaw.id) || ctx.heldRunKeys.has(runKey) || overlapsAny(ctx.heldRunRanges, holeId, num(incoming.fromDepth), num(incoming.toDepth))) {
        items.push({
          itemId: `${key}:${incomingRaw.id}`,
          table: key,
          status: 'held',
          action: 'keep',
          reason: '与待处理区回次同号或深度段重叠，避免重复回次，暂不并入',
          incomingId: incomingRaw.id,
          targetId,
          incomingRow: incoming,
        });
      } else {
        items.push({
          itemId: `${key}:${incomingRaw.id}`,
          table: key,
          status: 'auto',
          action: 'upsert',
          reason: '本机没有的新回次，自动并入',
          incomingId: incomingRaw.id,
          targetId,
          baseRev: baseRevFor(key, incomingRaw.id),
          incomingRev: revOf(incoming),
          incomingRow: incoming,
        });
      }
      if (pkgDupIds.has(incomingRaw.id) || ctx.heldRunKeys.has(runKey)) {
        ctx.heldRunKeys.add(runKey);
        ctx.heldRunRanges.push({ holeId, from: num(incoming.fromDepth), to: num(incoming.toDepth) });
      }
      continue;
    }

    const item = classifyExisting({ table: key, local: matched, incoming, baseRev: baseRevFor(key, incomingRaw.id), targetId, matchedByNaturalKey });
    items.push(item);
    if (item.status === 'pending' || item.status === 'held') {
      ctx.heldRunKeys.add(runKey);
      ctx.heldRunRanges.push({ holeId, from: num(matched.fromDepth), to: num(matched.toDepth) });
    }
  }

  for (const tomb of pkg.changes[key].deletes) {
    const localRow = localRows.find((row) => row.id === tomb.id);
    const itemId = `${key}:${tomb.id}`;
    if (!localRow) {
      items.push({ itemId, table: key, status: 'ignore', action: 'keep', reason: '本机已无该回次', incomingId: tomb.id, targetId: tomb.id });
      continue;
    }
    const holeId = String(localRow.holeId);
    const baseRev = baseRevFor(key, tomb.id);
    const localRev = revOf(localRow);
    if (ctx.pendingHoleIds.has(holeId)) {
      items.push({ itemId, table: key, status: 'held', action: 'keep', reason: '所属钻孔还在待处理区，删除暂不执行', incomingId: tomb.id, targetId: tomb.id, baseRev, localRev, localRow });
      ctx.heldRunKeys.add(`${holeId}|${String(localRow.runNo ?? '').trim()}`);
      ctx.heldRunRanges.push({ holeId, from: num(localRow.fromDepth), to: num(localRow.toDepth) });
      continue;
    }
    if (baseRev && localRev === baseRev) {
      items.push({ itemId, table: key, status: 'auto', action: 'delete', reason: '对端删除且本机未改，自动删除', incomingId: tomb.id, targetId: tomb.id, baseRev, localRev, localRow });
    } else {
      items.push({
        itemId,
        table: key,
        status: 'pending',
        action: 'keep',
        reason: baseRev ? '对端删除但本机在基线之后改过该回次，请确认' : '对端删除的回次缺少共同基线，需人工确认',
        incomingId: tomb.id,
        targetId: tomb.id,
        baseRev,
        localRev,
        localRow,
      });
      ctx.heldRunKeys.add(`${holeId}|${String(localRow.runNo ?? '').trim()}`);
      ctx.heldRunRanges.push({ holeId, from: num(localRow.fromDepth), to: num(localRow.toDepth) });
    }
  }
}

/* ------------------------------ 岩芯箱 ------------------------------ */

function reconcileBoxes(
  pkg: DeltaPackage,
  local: LocalTables,
  baseRevFor: (table: TableKey, id: string) => string | undefined,
  items: ReconcileItem[],
  ctx: ReconcileContext,
): void {
  const key = 'boxes';
  const localRows = local.boxes;
  const incomingRows = pkg.changes[key].upserts;
  const usedLocal = new Set<string>();

  const pkgBoxKeys = new Map<string, string>();
  const pkgDupIds = new Set<string>();
  for (const row of incomingRows) {
    const holeId = mapHoleId(ctx, row.holeId);
    const k = `${holeId}|${String(row.boxNo ?? '').trim()}`;
    const prev = pkgBoxKeys.get(k);
    if (prev) {
      pkgDupIds.add(row.id);
      pkgDupIds.add(prev);
    } else {
      pkgBoxKeys.set(k, row.id);
    }
  }

  for (const incomingRaw of incomingRows) {
    const incoming: SourcedRow = { ...incomingRaw, holeId: mapHoleId(ctx, incomingRaw.holeId) };
    const holeId = String(incoming.holeId);
    const boxKey = `${holeId}|${String(incoming.boxNo ?? '').trim()}`;
    const from = num(incoming.fromDepth);
    const to = num(incoming.toDepth);

    if (ctx.pendingHoleIds.has(holeId)) {
      pushBoxHeld(items, ctx, key, incomingRaw.id, incomingRaw.id, incoming, '所属钻孔还在待处理区，岩芯箱暂不自动合并', holeId, boxKey, from, to);
      continue;
    }
    if (ctx.deletedHoleIds.has(holeId)) {
      pushBoxHeld(items, ctx, key, incomingRaw.id, incomingRaw.id, incoming, '所属钻孔在同包内被整孔删除，岩芯箱新增不并入', holeId, boxKey, from, to);
      continue;
    }

    let matched = localRows.find((row) => row.id === incomingRaw.id);
    let matchedByNaturalKey = false;
    if (matched) usedLocal.add(matched.id);
    if (!matched) {
      matched = localRows.find(
        (row) => !usedLocal.has(row.id) && String(row.holeId) === holeId && String(row.boxNo ?? '').trim() === String(incoming.boxNo ?? '').trim(),
      );
      if (matched) {
        usedLocal.add(matched.id);
        matchedByNaturalKey = true;
      }
    }
    // 同孔装箱深度重叠也视为同一箱（防止重复装箱）
    if (!matched) {
      matched = localRows.find(
        (row) =>
          !usedLocal.has(row.id) &&
          String(row.holeId) === holeId &&
          rangesOverlap(num(row.fromDepth), num(row.toDepth), from, to),
      );
      if (matched) {
        usedLocal.add(matched.id);
        matchedByNaturalKey = true;
      }
    }

    const targetId = matched ? matched.id : incomingRaw.id;

    if (!matched) {
      const blockedByRun = overlapsAny(ctx.heldRunRanges, holeId, from, to);
      const blockedByBox = ctx.heldBoxKeys.has(boxKey) || overlapsAny(ctx.heldBoxRanges, holeId, from, to);
      if (pkgDupIds.has(incomingRaw.id) || blockedByRun || blockedByBox) {
        const reason = blockedByRun
          ? '箱段深度与待处理回次重叠，待回次定版后再并'
          : blockedByBox
            ? '与待处理区岩芯箱同箱号或深度重叠，避免重复生成箱号，暂不并入'
            : '差量包内存在同孔同箱号的新箱，需人工核对';
        pushBoxHeld(items, ctx, key, incomingRaw.id, targetId, incoming, reason, holeId, boxKey, from, to);
      } else {
        items.push({
          itemId: `${key}:${incomingRaw.id}`,
          table: key,
          status: 'auto',
          action: 'upsert',
          reason: '本机没有的新岩芯箱，自动并入',
          incomingId: incomingRaw.id,
          targetId,
          baseRev: baseRevFor(key, incomingRaw.id),
          incomingRev: revOf(incoming),
          incomingRow: incoming,
        });
      }
      continue;
    }

    const item = classifyExisting({ table: key, local: matched, incoming, baseRev: baseRevFor(key, incomingRaw.id), targetId, matchedByNaturalKey });
    items.push(item);
    if (item.status === 'pending' || item.status === 'held') {
      ctx.heldBoxKeys.add(boxKey);
      ctx.heldBoxRanges.push({ holeId, from: num(matched.fromDepth), to: num(matched.toDepth) });
    }
  }

  for (const tomb of pkg.changes[key].deletes) {
    const localRow = localRows.find((row) => row.id === tomb.id);
    const itemId = `${key}:${tomb.id}`;
    if (!localRow) {
      items.push({ itemId, table: key, status: 'ignore', action: 'keep', reason: '本机已无该岩芯箱', incomingId: tomb.id, targetId: tomb.id });
      continue;
    }
    const holeId = String(localRow.holeId);
    const baseRev = baseRevFor(key, tomb.id);
    const localRev = revOf(localRow);
    if (ctx.pendingHoleIds.has(holeId)) {
      pushBoxHeld(items, ctx, key, tomb.id, tomb.id, localRow, '所属钻孔还在待处理区，删除暂不执行', holeId, `${holeId}|${String(localRow.boxNo ?? '').trim()}`, num(localRow.fromDepth), num(localRow.toDepth), baseRev, localRev);
      continue;
    }
    if (baseRev && localRev === baseRev) {
      items.push({ itemId, table: key, status: 'auto', action: 'delete', reason: '对端删除且本机未改，自动删除', incomingId: tomb.id, targetId: tomb.id, baseRev, localRev, localRow });
    } else {
      items.push({
        itemId,
        table: key,
        status: 'pending',
        action: 'keep',
        reason: baseRev ? '对端删除但本机在基线之后改过该岩芯箱，请确认' : '对端删除的岩芯箱缺少共同基线，需人工确认',
        incomingId: tomb.id,
        targetId: tomb.id,
        baseRev,
        localRev,
        localRow,
      });
      ctx.heldBoxKeys.add(`${holeId}|${String(localRow.boxNo ?? '').trim()}`);
      ctx.heldBoxRanges.push({ holeId, from: num(localRow.fromDepth), to: num(localRow.toDepth) });
    }
  }
}

function pushBoxHeld(
  items: ReconcileItem[],
  ctx: ReconcileContext,
  table: TableKey,
  incomingId: string,
  targetId: string,
  incomingRow: SourcedRow,
  reason: string,
  holeId: string,
  boxKey: string,
  from: number,
  to: number,
  baseRev?: string,
  localRev?: string,
  localRow?: SourcedRow,
): void {
  items.push({
    itemId: `${table}:${incomingId}`,
    table,
    status: 'held',
    action: 'keep',
    reason,
    incomingId,
    targetId,
    baseRev,
    localRev,
    incomingRow,
    localRow,
  });
  ctx.heldBoxKeys.add(boxKey);
  ctx.heldBoxRanges.push({ holeId, from, to });
}

/* ------------------------------ 岩性区间 ------------------------------ */

function reconcileLithos(
  pkg: DeltaPackage,
  local: LocalTables,
  baseRevFor: (table: TableKey, id: string) => string | undefined,
  items: ReconcileItem[],
  ctx: ReconcileContext,
): void {
  const key = 'lithos';
  const localRows = local.lithos;
  const incomingRows = pkg.changes[key].upserts;
  const usedLocal = new Set<string>();

  const rangeKey = (row: SourcedRow) => `${num(row.fromDepth)}|${num(row.toDepth)}`;
  const pkgRangeKeys = new Map<string, string>();
  const pkgDupIds = new Set<string>();
  for (const row of incomingRows) {
    const holeId = mapHoleId(ctx, row.holeId);
    const k = `${holeId}|${rangeKey(row)}`;
    const prev = pkgRangeKeys.get(k);
    if (prev) {
      pkgDupIds.add(row.id);
      pkgDupIds.add(prev);
    } else {
      pkgRangeKeys.set(k, row.id);
    }
  }

  for (const incomingRaw of incomingRows) {
    const incoming: SourcedRow = { ...incomingRaw, holeId: mapHoleId(ctx, incomingRaw.holeId) };
    const holeId = String(incoming.holeId);
    const from = num(incoming.fromDepth);
    const to = num(incoming.toDepth);

    if (ctx.pendingHoleIds.has(holeId) || ctx.deletedHoleIds.has(holeId)) {
      items.push({
        itemId: `${key}:${incomingRaw.id}`,
        table: key,
        status: 'held',
        action: 'keep',
        reason: ctx.deletedHoleIds.has(holeId)
          ? '所属钻孔在同包内被整孔删除，岩性区间新增不并入'
          : '所属钻孔还在待处理区，岩性区间暂不自动合并',
        incomingId: incomingRaw.id,
        targetId: incomingRaw.id,
        incomingRow: incoming,
      });
      ctx.heldLithoRanges.push({ holeId, from, to });
      continue;
    }

    let matched = localRows.find((row) => row.id === incomingRaw.id);
    let matchedByNaturalKey = false;
    if (matched) usedLocal.add(matched.id);
    if (!matched) {
      matched = localRows.find(
        (row) => !usedLocal.has(row.id) && String(row.holeId) === holeId && rangeKey(row) === rangeKey(incoming),
      );
      if (matched) {
        usedLocal.add(matched.id);
        matchedByNaturalKey = true;
      }
    }
    // 同孔深度重叠也视为同一区间（两边都编了同一段）
    if (!matched) {
      matched = localRows.find(
        (row) =>
          !usedLocal.has(row.id) &&
          String(row.holeId) === holeId &&
          rangesOverlap(num(row.fromDepth), num(row.toDepth), from, to),
      );
      if (matched) {
        usedLocal.add(matched.id);
        matchedByNaturalKey = true;
      }
    }

    const targetId = matched ? matched.id : incomingRaw.id;

    if (!matched) {
      const blockedByRun = overlapsAny(ctx.heldRunRanges, holeId, from, to);
      const blockedByLitho = pkgDupIds.has(incomingRaw.id) || overlapsAny(ctx.heldLithoRanges, holeId, from, to);
      if (blockedByRun || blockedByLitho) {
        const reason = blockedByRun
          ? '区间与待处理回次深度重叠，待回次定版后再并'
          : '与待处理区岩性区间重叠，避免重复生成岩性区间，暂不并入';
        items.push({
          itemId: `${key}:${incomingRaw.id}`,
          table: key,
          status: 'held',
          action: 'keep',
          reason,
          incomingId: incomingRaw.id,
          targetId,
          incomingRow: incoming,
        });
        ctx.heldLithoRanges.push({ holeId, from, to });
      } else {
        items.push({
          itemId: `${key}:${incomingRaw.id}`,
          table: key,
          status: 'auto',
          action: 'upsert',
          reason: '本机没有的新岩性区间，自动并入',
          incomingId: incomingRaw.id,
          targetId,
          baseRev: baseRevFor(key, incomingRaw.id),
          incomingRev: revOf(incoming),
          incomingRow: incoming,
        });
      }
      continue;
    }

    const item = classifyExisting({ table: key, local: matched, incoming, baseRev: baseRevFor(key, incomingRaw.id), targetId, matchedByNaturalKey });
    items.push(item);
    if (item.status === 'pending' || item.status === 'held') {
      ctx.heldLithoRanges.push({ holeId, from: num(matched.fromDepth), to: num(matched.toDepth) });
    }
  }

  for (const tomb of pkg.changes[key].deletes) {
    const localRow = local.lithos.find((row) => row.id === tomb.id);
    const itemId = `${key}:${tomb.id}`;
    if (!localRow) {
      items.push({ itemId, table: key, status: 'ignore', action: 'keep', reason: '本机已无该岩性区间', incomingId: tomb.id, targetId: tomb.id });
      continue;
    }
    const holeId = String(localRow.holeId);
    const baseRev = baseRevFor(key, tomb.id);
    const localRev = revOf(localRow);
    const protectedSample = String(localRow.sampleNo ?? '').trim();
    if (ctx.pendingHoleIds.has(holeId)) {
      items.push({ itemId, table: key, status: 'held', action: 'keep', reason: '所属钻孔还在待处理区，删除暂不执行', incomingId: tomb.id, targetId: tomb.id, baseRev, localRev, localRow });
      ctx.heldLithoRanges.push({ holeId, from: num(localRow.fromDepth), to: num(localRow.toDepth) });
      continue;
    }
    if (protectedSample) {
      items.push({
        itemId,
        table: key,
        status: 'pending',
        action: 'keep',
        reason: `该区间已登记样品 ${protectedSample}，样品事实不得随包删除，请人工处理`,
        incomingId: tomb.id,
        targetId: tomb.id,
        hardProtected: true,
        protectedFields: ['样品号'],
        baseRev,
        localRev,
        localRow,
      });
      ctx.heldLithoRanges.push({ holeId, from: num(localRow.fromDepth), to: num(localRow.toDepth) });
      continue;
    }
    if (baseRev && localRev === baseRev) {
      items.push({ itemId, table: key, status: 'auto', action: 'delete', reason: '对端删除且本机未改，自动删除', incomingId: tomb.id, targetId: tomb.id, baseRev, localRev, localRow });
    } else {
      items.push({
        itemId,
        table: key,
        status: 'pending',
        action: 'keep',
        reason: baseRev ? '对端删除但本机在基线之后改过该岩性区间，请确认' : '对端删除的岩性区间缺少共同基线，需人工确认',
        incomingId: tomb.id,
        targetId: tomb.id,
        baseRev,
        localRev,
        localRow,
      });
      ctx.heldLithoRanges.push({ holeId, from: num(localRow.fromDepth), to: num(localRow.toDepth) });
    }
  }
}

/* ------------------------------ 应用阶段：受保护字段合并 ------------------------------ */

/**
 * 编录员在待处理区选择「采用导入版本 / 并入非保护字段」时：
 * 受保护的终孔/样品事实始终保留本机值，其余字段采用导入值。
 */
export function buildIncomingWithLocalFacts(table: TableKey, local: SourcedRow, incoming: SourcedRow): SourcedRow {
  if (table === 'holes' && holeConfirmed(local)) {
    return { ...incoming, id: local.id, finalDepth: local.finalDepth, endDate: local.endDate };
  }
  if (table === 'lithos' && String(local.sampleNo ?? '').trim()) {
    return { ...incoming, id: local.id, sampleNo: local.sampleNo };
  }
  return { ...incoming, id: local.id };
}

/** 汇总计数（IO 层重试/刷新时复用） */
export function summarize(items: ReconcileItem[]): Pick<ReconcileResult, 'auto' | 'pending' | 'held' | 'ignored'> {
  const count = (status: ItemStatus) => items.filter((item) => item.status === status).length;
  return { auto: count('auto'), pending: count('pending'), held: count('held'), ignored: count('ignore') };
}

export { TABLE_KEYS };
