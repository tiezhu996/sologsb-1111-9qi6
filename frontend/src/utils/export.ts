import { db, SCHEMA_VERSION, getDeviceIdentity, backfillAllOrigins } from './db';
import { ensureOrigin, type SourcedRow } from './provenance';

export interface BackupPayload {
  app: string;
  schemaVersion: number;
  exportedAt: string;
  holes: unknown[];
  runs: unknown[];
  boxes: unknown[];
  lithos: unknown[];
}

/** 汇总全部本地表为 JSON 备份（schema 迁移前先导出） */
export async function buildBackup(): Promise<BackupPayload> {
  const [holes, runs, boxes, lithos] = await Promise.all([
    db.holes.toArray(),
    db.runs.toArray(),
    db.boxes.toArray(),
    db.lithos.toArray(),
  ]);
  return {
    app: 'gbdrillcore',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    holes,
    runs,
    boxes,
    lithos,
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
  downloadText(filename, `\ufeff${header}\n${body}`, 'text/csv');
}

/** 恢复 JSON 备份（整库覆盖；恢复后对缺少来源字段的旧数据按兼容规则回填） */
export async function importBackup(text: string): Promise<{ holes: number; runs: number; boxes: number; lithos: number }> {
  const payload = JSON.parse(text) as Partial<BackupPayload>;
  if (!payload || payload.app !== 'gbdrillcore') {
    throw new Error('备份文件格式不匹配（缺少 app=gbdrillcore 标记）');
  }
  const counts = {
    holes: payload.holes?.length ?? 0,
    runs: payload.runs?.length ?? 0,
    boxes: payload.boxes?.length ?? 0,
    lithos: payload.lithos?.length ?? 0,
  };
  const identity = await getDeviceIdentity();
  const stamp = (row: unknown) => ensureOrigin(row as SourcedRow, identity);
  await db.transaction('rw', db.holes, db.runs, db.boxes, db.lithos, async () => {
    await Promise.all([db.holes.clear(), db.runs.clear(), db.boxes.clear(), db.lithos.clear()]);
    if (payload.holes?.length) await db.holes.bulkPut(payload.holes.map(stamp) as never[]);
    if (payload.runs?.length) await db.runs.bulkPut(payload.runs.map(stamp) as never[]);
    if (payload.boxes?.length) await db.boxes.bulkPut(payload.boxes.map(stamp) as never[]);
    if (payload.lithos?.length) await db.lithos.bulkPut(payload.lithos.map(stamp) as never[]);
  });
  // 兜底：库里若还有任何缺来源的记录（历史遗留），统一回填
  await backfillAllOrigins(identity);
  return counts;
}
