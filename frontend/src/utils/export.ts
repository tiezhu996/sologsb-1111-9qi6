import { db, SCHEMA_VERSION } from './db';
import { ensureEnvelope } from '../sync/clock';
import type { Tombstone } from '../sync/types';

export interface BackupPayload {
  app: string;
  schemaVersion: number;
  exportedAt: string;
  holes: unknown[];
  runs: unknown[];
  boxes: unknown[];
  lithos: unknown[];
  /** 差量同步的逻辑删除标记（v3 起随备份保存） */
  tombstones?: Tombstone[];
}

/** 汇总全部本地表为 JSON 备份（schema 迁移前先导出） */
export async function buildBackup(): Promise<BackupPayload> {
  const [holes, runs, boxes, lithos, tombstones] = await Promise.all([
    db.holes.toArray(),
    db.runs.toArray(),
    db.boxes.toArray(),
    db.lithos.toArray(),
    db.tombstones.toArray(),
  ]);
  return {
    app: 'gbdrillcore',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    holes,
    runs,
    boxes,
    lithos,
    tombstones,
  };
}

export async function exportBackupJson(): Promise<string> {
  return JSON.stringify(await buildBackup(), null, 2);
}

export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 导出 CSV（岩芯编目表打印用） */
export function downloadCsv<T extends Record<string, unknown>>(
  filename: string,
  rows: T[],
  columns: Array<{ key: keyof T; title: string }>,
): void {
  const header = columns.map((c) => `"${c.title}"`).join(',');
  const body = rows
    .map((row) => columns.map((c) => `"${String(row[c.key] ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
  downloadText(filename, `﻿${header}\n${body}`, 'text/csv');
}

/**
 * 恢复 JSON 备份（整库覆盖，与差量合并是两个入口）：
 * - 旧备份缺少来源字段时按兼容规则回填公共祖先信封；
 * - 不清空 tombstones/pending：恢复后墓碑仍在，旧数据不会借备份复活，
 *   若恢复行与墓碑 id 相同则一并移除墓碑（视为人工确认恢复该对象）。
 */
export async function importBackup(text: string): Promise<{ holes: number; runs: number; boxes: number; lithos: number }> {
  const payload = JSON.parse(text) as Partial<BackupPayload>;
  if (!payload || payload.app !== 'gbdrillcore') {
    throw new Error('备份文件格式不匹配（缺少 app=gbdrillcore 标记）');
  }

  const backfill = (rows: unknown[] | undefined) =>
    (rows ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      ensureEnvelope(row);
      return row;
    });

  const holes = backfill(payload.holes);
  const runs = backfill(payload.runs);
  const boxes = backfill(payload.boxes);
  const lithos = backfill(payload.lithos);

  const counts = {
    holes: holes.length,
    runs: runs.length,
    boxes: boxes.length,
    lithos: lithos.length,
  };
  await db.transaction('rw', db.holes, db.runs, db.boxes, db.lithos, db.tombstones, async () => {
    await Promise.all([db.holes.clear(), db.runs.clear(), db.boxes.clear(), db.lithos.clear()]);
    if (holes.length) await db.holes.bulkPut(holes as never[]);
    if (runs.length) await db.runs.bulkPut(runs as never[]);
    if (boxes.length) await db.boxes.bulkPut(boxes as never[]);
    if (lithos.length) await db.lithos.bulkPut(lithos as never[]);

    if (Array.isArray(payload.tombstones)) {
      // v3+ 备份：连同墓碑整体恢复
      await db.tombstones.clear();
      if (payload.tombstones.length) await db.tombstones.bulkPut(payload.tombstones);
    } else {
      // 旧备份（无墓碑段）：恢复对象若恰好被本地逻辑删除，移除其墓碑，尊重人工恢复
      const restoredIds = new Set([
        ...holes.map((r) => `holes:${String(r.id)}`),
        ...runs.map((r) => `runs:${String(r.id)}`),
        ...boxes.map((r) => `boxes:${String(r.id)}`),
        ...lithos.map((r) => `lithos:${String(r.id)}`),
      ]);
      const stale = await db.tombstones.filter((t) => restoredIds.has(t.id)).primaryKeys();
      if (stale.length) await db.tombstones.bulkDelete(stale);
    }
  });
  return counts;
}
