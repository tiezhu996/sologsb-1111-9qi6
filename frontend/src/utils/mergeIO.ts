/**
 * 差量导入的暂存与整包原子应用。
 *
 * 流程：
 *  1. 解析差量包 → 三方对账（merge.reconcile，纯逻辑）→ 结果写入 mergeStaging；
 *  2. 编录员在待处理区逐项选定版本（决议只写暂存，不动四张业务表）；
 *  3. 点「整包应用」：单一 Dexie 事务写 holes/runs/boxes/lithos（+meta），
 *     事务内再次校验终孔/样品保护、孔号/箱号/回次号/岩性区间重复；
 *     任一项失败整体回滚，四张旧表原样保留，暂存不动，可直接重试；
 *  4. 成功后把已应用项移出暂存（仍未处理的继续留待处理区）。
 */
import { db } from './db';
import {
  type DeltaPackage,
  type TableKey,
  TABLE_KEYS,
  readPeerBaseline,
  registerPeerFromImport,
} from './deltaPackage';
import { contentRev, revOf, stampCreate, stampUpdate, type DeviceIdentity, type SourcedRow } from './provenance';
import { rangesOverlap } from './recovery';
import {
  buildIncomingWithLocalFacts,
  holeConfirmed,
  reconcile,
  type ReconcileItem,
  type ReconcileResult,
  type ResolutionChoice,
} from './merge';

const STAGING_KEY = 'current';

export interface StagedMerge {
  pkg: DeltaPackage;
  items: ReconcileItem[];
  /** itemId → 编录员决议 */
  resolutions: Record<string, ResolutionChoice>;
  stagedAt: string;
  updatedAt: string;
}

export class MergeGuardError extends Error {}

/* ------------------------------ 暂存取放 ------------------------------ */

export async function stageReconciliation(pkg: DeltaPackage): Promise<StagedMerge> {
  const local = await loadLocal();
  // 补充共同祖先按「来源对端」取本机发包游标（target 是本机自己，不能用它）；
  // 通用包/首次对接时该游标为空，不影响对账。
  const cursor = await readPeerBaseline(pkg.source.id);
  const result: ReconcileResult = reconcile(pkg, local, cursor);
  const staged: StagedMerge = {
    pkg,
    items: result.items,
    resolutions: {},
    stagedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await db.mergeStaging.put({ key: STAGING_KEY, value: staged });
  return staged;
}

export async function loadStaged(): Promise<StagedMerge | undefined> {
  const row = await db.mergeStaging.get(STAGING_KEY);
  return row?.value as StagedMerge | undefined;
}

async function saveStaged(staged: StagedMerge): Promise<void> {
  await db.mergeStaging.put({ key: STAGING_KEY, value: { ...staged, updatedAt: new Date().toISOString() } });
}

export async function clearStaged(): Promise<void> {
  await db.mergeStaging.clear();
}

/* ------------------------------ 编录员决议 ------------------------------ */

export async function setResolution(itemId: string, choice: ResolutionChoice): Promise<StagedMerge | undefined> {
  const staged = await loadStaged();
  if (!staged) return undefined;
  const item = staged.items.find((entry) => entry.itemId === itemId);
  if (!item) return staged;
  if (choice === 'take-incoming' && item.hardProtected) {
    throw new MergeGuardError('该记录含本机已确认的终孔/样品事实，不能整行采用导入版本；请选择「并入非保护字段」（事实字段保留本机）');
  }
  staged.resolutions[itemId] = choice;
  await saveStaged(staged);
  return staged;
}

export async function clearResolution(itemId: string): Promise<StagedMerge | undefined> {
  const staged = await loadStaged();
  if (!staged) return undefined;
  delete staged.resolutions[itemId];
  await saveStaged(staged);
  return staged;
}

/* ------------------------------ 应用规划 ------------------------------ */

type LocalTables = Record<TableKey, SourcedRow[]>;

async function loadLocal(): Promise<LocalTables> {
  const [holes, runs, boxes, lithos] = await Promise.all([
    db.holes.toArray(),
    db.runs.toArray(),
    db.boxes.toArray(),
    db.lithos.toArray(),
  ]);
  return {
    holes: holes as unknown as SourcedRow[],
    runs: runs as unknown as SourcedRow[],
    boxes: boxes as unknown as SourcedRow[],
    lithos: lithos as unknown as SourcedRow[],
  };
}

/** 决议后该项的最终状态 */
function resolvedStatus(item: ReconcileItem, choice: ResolutionChoice | undefined): ReconcileItem['status'] {
  if (item.status === 'auto') return 'auto';
  if (!choice) return item.status;
  // 选了就视为已定版，等待整包应用
  return 'auto';
}

function isExecutable(item: ReconcileItem, choice: ResolutionChoice | undefined): boolean {
  if (item.status === 'auto') return true;
  if (item.status === 'ignore') return false;
  if (item.status === 'held' || item.status === 'pending') {
    return Boolean(choice) && choice !== undefined;
  }
  return false;
}

/** 依据决议生成落库行（含 id 重映射、受保护事实保留、来源章） */
function buildEffectiveRow(item: ReconcileItem, choice: ResolutionChoice | undefined, identity: DeviceIdentity): SourcedRow | undefined {
  const writesIncoming = choice === 'take-incoming' || choice === 'merge-incoming-nonprotected';
  if (item.action !== 'upsert' && !writesIncoming) return undefined;
  const incoming = item.incomingRow;
  if (!incoming) return undefined;

  // 决议：保留本机 → 不写
  if (item.status !== 'auto' && choice === 'keep-local') return undefined;
  // 决议确认删除 → 交删除集合处理
  if (choice === 'confirm-delete') return undefined;

  // 决议「采用导入版本」：
  //  - 普通冲突：整行采用导入（id 对到本机）
  //  - 含受保护事实：只允许「并入非保护字段」，终孔深度/终孔日期/样品号强制保留本机
  let row: SourcedRow;
  if (item.status !== 'auto' && (choice === 'take-incoming' || choice === 'merge-incoming-nonprotected') && item.localRow) {
    if (item.hardProtected && choice === 'take-incoming') {
      throw new MergeGuardError('该记录含本机已确认事实，不能整行采用导入版本，请选择「并入非保护字段」');
    }
    row = buildIncomingWithLocalFacts(item.table, item.localRow, incoming);
  } else {
    row = { ...incoming, id: item.targetId };
  }

  // 加盖来源章：沿用导入记录的来源，修订号按落库内容重算；更新时间保留对端的，无来源时本机兜底
  const existing = item.localRow;
  if (existing && existing.id === row.id) {
    row = stampUpdate(existing, row, identity, row._origin?.updatedAt ?? new Date().toISOString());
  } else {
    row = stampCreate(row, identity, row._origin?.createdAt ?? new Date().toISOString());
  }
  return row;
}

/** 自动 upsert 项原本 action 就是 upsert；决议型 take-incoming 需要落库 */
function wantsUpsert(item: ReconcileItem, choice: ResolutionChoice | undefined): boolean {
  if (item.action === 'upsert' && item.status === 'auto') return true;
  return choice === 'take-incoming' || choice === 'merge-incoming-nonprotected';
}

function wantsDelete(item: ReconcileItem, choice: ResolutionChoice | undefined): boolean {
  if (item.action === 'delete' && item.status === 'auto') return true;
  return choice === 'confirm-delete';
}

/* ------------------------------ 事务内守卫 ------------------------------ */

function assertUniqueHoleNo(rows: SourcedRow[], incoming: SourcedRow): void {
  const no = String(incoming.holeNo ?? '').trim();
  const dup = rows.find((row) => row.id !== incoming.id && String(row.holeNo ?? '').trim() === no);
  if (dup) throw new MergeGuardError(`孔号 ${no} 已存在（${dup.id}），为避免重复钻孔，已回滚`);
}

function assertParentHoleExists(rows: SourcedRow[], child: SourcedRow): void {
  if (!rows.some((hole) => hole.id === String(child.holeId))) {
    throw new MergeGuardError(`记录 ${child.id} 所属钻孔 ${child.holeId} 不存在，已回滚`);
  }
}

function assertRunUnique(rows: SourcedRow[], incoming: SourcedRow): void {
  const holeId = String(incoming.holeId);
  const runNo = String(incoming.runNo ?? '').trim();
  const dupNo = rows.find(
    (row) => row.id !== incoming.id && String(row.holeId) === holeId && String(row.runNo ?? '').trim() === runNo,
  );
  if (dupNo) throw new MergeGuardError(`同孔回次号 ${runNo} 已存在，为避免重复回次，已回滚`);
  const dupRange = rows.find(
    (row) =>
      row.id !== incoming.id &&
      String(row.holeId) === holeId &&
      rangesOverlap(Number(row.fromDepth), Number(row.toDepth), Number(incoming.fromDepth), Number(incoming.toDepth)),
  );
  if (dupRange) {
    throw new MergeGuardError(
      `回次深度 ${incoming.fromDepth}~${incoming.toDepth}m 与已有回次 ${dupRange.runNo} 重叠，为避免重复生成回次，已回滚`,
    );
  }
}

function assertBoxUnique(rows: SourcedRow[], incoming: SourcedRow): void {
  const holeId = String(incoming.holeId);
  const boxNo = String(incoming.boxNo ?? '').trim();
  const dupNo = rows.find(
    (row) => row.id !== incoming.id && String(row.holeId) === holeId && String(row.boxNo ?? '').trim() === boxNo,
  );
  if (dupNo) throw new MergeGuardError(`同孔箱号 ${boxNo} 已存在，为避免重复生成箱号，已回滚`);
  const dupRange = rows.find(
    (row) =>
      row.id !== incoming.id &&
      String(row.holeId) === holeId &&
      rangesOverlap(Number(row.fromDepth), Number(row.toDepth), Number(incoming.fromDepth), Number(incoming.toDepth)),
  );
  if (dupRange) {
    throw new MergeGuardError(
      `岩芯箱深度 ${incoming.fromDepth}~${incoming.toDepth}m 与已有箱 ${dupRange.boxNo} 重叠，为避免重复装箱，已回滚`,
    );
  }
}

function assertLithoUnique(rows: SourcedRow[], incoming: SourcedRow): void {
  const holeId = String(incoming.holeId);
  const dup = rows.find(
    (row) =>
      row.id !== incoming.id &&
      String(row.holeId) === holeId &&
      rangesOverlap(Number(row.fromDepth), Number(row.toDepth), Number(incoming.fromDepth), Number(incoming.toDepth)),
  );
  if (dup) {
    throw new MergeGuardError(
      `岩性区间 ${incoming.fromDepth}~${incoming.toDepth}m 与已有区间 ${dup.fromDepth}~${dup.toDepth}m 重叠，为避免重复生成岩性区间，已回滚`,
    );
  }
}

/** 应用前/事务内：终孔与样品事实最终核对（决议之后也不能突破） */
function assertHardFacts(final: LocalTables): void {
  for (const hole of final.holes) {
    if (holeConfirmed(hole)) {
      // 已终孔孔不允许被改为未终孔：所有落库路径本身保留本机事实，此处兜底
      if (!(Number(hole.finalDepth) > 0) && !String(hole.endDate ?? '').trim()) {
        throw new MergeGuardError(`钻孔 ${hole.holeNo} 的已确认终孔事实丢失，已回滚`);
      }
    }
  }
}

/* ------------------------------ 整包应用 ------------------------------ */

export interface ApplyResult {
  applied: number;
  deleted: number;
  upserted: number;
  remaining: number;
}

/**
 * 整包应用。全部可执行项在一个事务内完成；任一守卫失败则全部回滚，
 * 四张旧表保持原样，暂存保留可重试。
 */
export async function applyStagedMerge(identity: DeviceIdentity): Promise<ApplyResult> {
  const staged = await loadStaged();
  if (!staged) throw new MergeGuardError('暂存区已空，没有可应用的差量包');

  const choiceOf = (item: ReconcileItem) => staged.resolutions[item.itemId];

  // 规划动作（应用前先在内存里模拟，尽早给出明确的失败原因，不动业务表）
  const upserts: Record<TableKey, SourcedRow[]> = { holes: [], runs: [], boxes: [], lithos: [] };
  const deletes: Record<TableKey, Set<string>> = {
    holes: new Set(),
    runs: new Set(),
    boxes: new Set(),
    lithos: new Set(),
  };

  for (const item of staged.items) {
    const choice = choiceOf(item);
    if (!isExecutable(item, choice)) continue;
    if (wantsDelete(item, choice)) {
      deletes[item.table].add(item.targetId);
    } else if (wantsUpsert(item, choice)) {
      const row = buildEffectiveRow(item, choice, identity);
      if (row) upserts[item.table].push(row);
    }
  }

  // 决议「确认删除」整孔时做孤儿守卫：孔下尚存子记录必须在同批一并删除
  if (deletes.holes.size) {
    const preLocal = await loadLocal();
    for (const holeId of deletes.holes) {
      for (const key of ['runs', 'boxes', 'lithos'] as const) {
        const orphan = preLocal[key].find((row) => String(row.holeId) === holeId && !deletes[key].has(row.id));
        if (orphan) {
          throw new MergeGuardError(`钻孔 ${holeId} 下仍有未删除的${key === 'runs' ? '回次' : key === 'boxes' ? '岩芯箱' : '岩性'}（${orphan.id}），整孔删除已中止，四张旧表已保留`);
        }
      }
    }
  }

  const mergedAt = new Date().toISOString();

  try {
    await db.transaction('rw', db.holes, db.runs, db.boxes, db.lithos, db.meta, async () => {
      // 事务内重新取数：防止对账后本机又改过（陈旧暂存）
      const current = await loadLocal();

      // 陈旧检测：对将被影响的本机记录核对修订号
      for (const item of staged.items) {
        const choice = choiceOf(item);
        if (!isExecutable(item, choice) && item.status !== 'auto') continue;
        if (item.localRow) {
          const now = current[item.table].find((row) => row.id === item.localRow!.id);
          if (now && revOf(now) !== item.localRev) {
            throw new MergeGuardError(
              `对账后本机记录 ${item.localRow.id} 又被修改过，为避免覆盖请重新导入对账（四张旧表已保留）`,
            );
          }
        }
      }

      const finalTables: LocalTables = {
        holes: current.holes.filter((row) => !deletes.holes.has(row.id)),
        runs: current.runs.filter((row) => !deletes.runs.has(row.id)),
        boxes: current.boxes.filter((row) => !deletes.boxes.has(row.id)),
        lithos: current.lithos.filter((row) => !deletes.lithos.has(row.id)),
      };

      // 逐项写入并做唯一/重叠守卫
      for (const hole of upserts.holes) {
        assertUniqueHoleNo(finalTables.holes, hole);
        upsertInto(finalTables.holes, hole);
      }
      for (const run of upserts.runs) {
        assertParentHoleExists(finalTables.holes, run);
        assertRunUnique(finalTables.runs, run);
        upsertInto(finalTables.runs, run);
      }
      for (const box of upserts.boxes) {
        assertParentHoleExists(finalTables.holes, box);
        assertBoxUnique(finalTables.boxes, box);
        upsertInto(finalTables.boxes, box);
      }
      for (const litho of upserts.lithos) {
        assertParentHoleExists(finalTables.holes, litho);
        assertLithoUnique(finalTables.lithos, litho);
        upsertInto(finalTables.lithos, litho);
      }

      assertHardFacts(finalTables);

      // 落库：仅写差异，未涉及记录原样保留
      if (deletes.holes.size) await db.holes.bulkDelete([...deletes.holes]);
      if (upserts.holes.length) await db.holes.bulkPut(upserts.holes as never[]);
      if (deletes.runs.size) await db.runs.bulkDelete([...deletes.runs]);
      if (upserts.runs.length) await db.runs.bulkPut(upserts.runs as never[]);
      if (deletes.boxes.size) await db.boxes.bulkDelete([...deletes.boxes]);
      if (upserts.boxes.length) await db.boxes.bulkPut(upserts.boxes as never[]);
      if (deletes.lithos.size) await db.lithos.bulkDelete([...deletes.lithos]);
      if (upserts.lithos.length) await db.lithos.bulkPut(upserts.lithos as never[]);

      await registerPeerFromImport({ id: staged.pkg.source.id, name: staged.pkg.source.name }, mergedAt);
    });
  } catch (error) {
    // Dexie 事务已整体回滚：四张旧表原样保留，暂存保留以便重试
    if (error instanceof MergeGuardError) throw error;
    throw new MergeGuardError(`整包写入失败，已保留四张旧表，可修正后重试：${(error as Error).message}`);
  }

  // 成功后：移出已应用项；未处理项继续留在待处理区（不进入后续自动合并）
  const appliedIds = new Set<string>();
  let deletedCount = 0;
  let upsertedCount = 0;
  for (const item of staged.items) {
    const choice = choiceOf(item);
    if (isExecutable(item, choice)) {
      appliedIds.add(item.itemId);
      if (wantsDelete(item, choice)) deletedCount += 1;
      else if (wantsUpsert(item, choice)) upsertedCount += 1;
    }
  }

  const nextItems = staged.items.filter((item) => !appliedIds.has(item.itemId));
  const nextResolutions: Record<string, ResolutionChoice> = {};
  for (const item of nextItems) {
    const choice = staged.resolutions[item.itemId];
    if (choice) nextResolutions[item.itemId] = choice;
  }

  if (nextItems.length === 0) {
    await db.mergeStaging.clear();
  } else {
    await db.mergeStaging.put({
      key: STAGING_KEY,
      value: { ...staged, items: nextItems, resolutions: nextResolutions, updatedAt: mergedAt },
    });
  }

  return {
    applied: appliedIds.size,
    deleted: deletedCount,
    upserted: upsertedCount,
    remaining: nextItems.length,
  };
}

function upsertInto(rows: SourcedRow[], row: SourcedRow): void {
  const index = rows.findIndex((existing) => existing.id === row.id);
  if (index >= 0) rows[index] = row;
  else rows.push(row);
}

/** 暂存区是否还有待处理项（页面徽标用） */
export async function countStagedPending(): Promise<number> {
  const staged = await loadStaged();
  if (!staged) return 0;
  return staged.items.filter((item) => item.status === 'pending' || item.status === 'held').length;
}
