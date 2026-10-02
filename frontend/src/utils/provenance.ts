/**
 * 记录来源与基线版本（修订号）。
 *
 * 四张业务表（holes/runs/boxes/lithos）的每条记录都挂 `_origin`：
 *  - 首次创建它的设备（记录来源）
 *  - 创建/最近修改时间
 *  - rev：按业务字段计算的内容修订号，用于差量对账的三方比对
 *
 * 旧数据没有 `_origin` 时按兼容规则回填（见 db v3 升级与 deltaPackage.backfillAllOrigins）。
 */

/** 记录来源（挂在每条业务记录上） */
export interface RecordOrigin {
  /** 首次生成该记录的设备 id */
  deviceId: string;
  /** 首次生成该记录的设备名（编录本可命名） */
  deviceName: string;
  /** 首次创建时间 ISO */
  createdAt: string;
  /** 最近修改时间 ISO */
  updatedAt: string;
  /** 业务内容修订号（与来源元数据本身无关） */
  rev: string;
}

/** 本机设备标识（存 meta 表） */
export interface DeviceIdentity {
  id: string;
  name: string;
  createdAt: string;
}

export type SourcedRow = { id: string; _origin?: RecordOrigin; [key: string]: unknown };

/** 带可选来源章的业务记录（具体接口用这个约束，避免要求索引签名） */
export type OriginAware = { id: string; _origin?: RecordOrigin };

const PROVENANCE_FIELDS = new Set(['_origin']);

/** 稳定序列化：对象键排序、剥离来源字段，保证同内容同结果、与键顺序无关 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((key) => !PROVENANCE_FIELDS.has(key))
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** FNV-1a 32 位修订号（离线内容比对，非密码学用途） */
export function contentRev(row: unknown): string {
  const text = stableStringify(row);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function nowIso(): string {
  return new Date().toISOString();
}

type Stamped<T> = T & { _origin: RecordOrigin };

/** 新建记录盖来源章 */
export function stampCreate<T extends OriginAware>(row: T, identity: DeviceIdentity, at: string = nowIso()): Stamped<T> {
  const rev = contentRev(row);
  return {
    ...row,
    _origin: {
      deviceId: identity.id,
      deviceName: identity.name,
      createdAt: at,
      updatedAt: at,
      rev,
    },
  };
}

/** 修改记录盖更新章：保留最初来源，刷新修改时间与修订号 */
export function stampUpdate<T extends OriginAware>(
  prev: T,
  next: T,
  identity: DeviceIdentity,
  at: string = nowIso(),
): Stamped<T> {
  const created = prev._origin;
  const rev = contentRev(next);
  return {
    ...next,
    _origin: {
      deviceId: created?.deviceId ?? identity.id,
      deviceName: created?.deviceName ?? identity.name,
      createdAt: created?.createdAt ?? at,
      updatedAt: at,
      rev,
    },
  };
}

/** 兼容回填：旧记录缺少来源字段时，按本机来源补齐（rev 始终重算兜底） */
export function ensureOrigin<T extends OriginAware>(row: T, identity: DeviceIdentity, at: string = nowIso()): Stamped<T> {
  if (!row._origin || !row._origin.deviceId || !row._origin.rev) {
    return stampCreate(row, identity, at);
  }
  const expectedRev = contentRev(row);
  if (row._origin.rev !== expectedRev) {
    return { ...row, _origin: { ...row._origin, rev: expectedRev } };
  }
  return row as Stamped<T>;
}

/** 取记录修订号；缺来源字段的旧记录现场计算（不写库） */
export function revOf(row: OriginAware): string {
  return row._origin?.rev || contentRev(row);
}
