import {
  SESSION_PREFERENCE_FIELDS as SHARED_FIELDS,
  emptySessionPreferences,
  parseSessionPreferences,
  parseSessionPreferencesPatch,
  type SessionPreferenceApproval,
  type SessionPreferenceField,
  type SessionPreferenceMode,
  type SessionPreferences as SharedSessionPreferences,
  type SessionPreferencesPatch,
} from '@extensions/_shared/session-preferences';

/**
 * 渲染侧的会话偏好投影。
 *
 * 形状与解析规则都来自后端共享模块 `@extensions/_shared/session-preferences.ts`：
 * 这里只做 re-export 与「owner 身份 / 前端缓存」相关的补充，避免两份定义漂移。
 */
export type SessionPreferences = SharedSessionPreferences;
export type { SessionPreferenceField, SessionPreferencesPatch, SessionPreferenceMode, SessionPreferenceApproval };

export const SESSION_PREFERENCE_FIELDS: SessionPreferenceField[] = [...SHARED_FIELDS];

export function emptyPreferences(): SessionPreferences {
  return emptySessionPreferences();
}

/** 统一校验入口（回执/本地存档读回都过它）。非法字段丢弃，不会整组清零。 */
export function pickDefinedPreferences(raw: unknown): SessionPreferences {
  return parseSessionPreferences(raw);
}

/** 只取 patch 字段（不含 revision），用于构造 setter 入参。 */
export function pickPreferencesPatch(raw: unknown): SessionPreferencesPatch {
  return parseSessionPreferencesPatch(raw);
}

/** 回执显式带的 revision；缺省/非法返回 undefined（不能把缺省当 0 覆盖本地版本）。 */
export function readPreferencesRevision(raw: unknown): number | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const revision = (raw as { revision?: unknown }).revision;
  return typeof revision === 'number' && Number.isInteger(revision) && revision >= 0 ? revision : undefined;
}

/**
 * 合并字段补丁但不推进 revision：revision 只由宿主回执推进。
 * 展示层做乐观更新时用它，否则本地会造出一个宿主没确认过的版本号。
 */
export function mergePreferences(
  base: SessionPreferences,
  patch: SessionPreferencesPatch,
): SessionPreferences {
  const parsed = parseSessionPreferencesPatch(patch);
  // 逐字段赋值：SessionPreferences 没有索引签名，用 Record 强转会被 TS2352 拒绝。
  return {
    ...base,
    ...(parsed.model ? { model: parsed.model } : {}),
    ...(parsed.thinkingLevel ? { thinkingLevel: parsed.thinkingLevel } : {}),
    ...(parsed.mode ? { mode: parsed.mode } : {}),
    ...(parsed.approval ? { approval: parsed.approval } : {}),
    // false 是有效值：必须按 boolean 判定，不能走 truthy 过滤。
    ...(typeof parsed.fastMode === 'boolean' ? { fastMode: parsed.fastMode } : {}),
  };
}

const DRAFT_PREFIX = 'draft:';

/** 草稿 owner key：不以 cwd 代替身份，同项目两份未落盘草稿互不覆盖。 */
export function draftOwnerKey(id: string): string {
  return id.startsWith(DRAFT_PREFIX) ? id : `${DRAFT_PREFIX}${id}`;
}

export function isDraftOwnerKey(key: string | null | undefined): boolean {
  return typeof key === 'string' && key.startsWith(DRAFT_PREFIX);
}

/** 会话 owner key：后端能按路径定位 handle 的会话文件（.jsonl）。其余（草稿/workspace）都不是。 */
export function isSessionOwnerKey(key: string | null | undefined): boolean {
  return typeof key === 'string' && !isDraftOwnerKey(key) && /\.jsonl$/i.test(key);
}

/** 从 owner key 取会话路径；草稿与 workspace 兼容键返回 null（不能拿它去调会话 setter）。 */
export function sessionPathFromOwnerKey(key: string | null | undefined): string | null {
  return isSessionOwnerKey(key) ? (key as string) : null;
}

/**
 * 比较用的归一化键。只用于 store 键与前后比较，回后端时必须用原始 key，
 * 否则大小写/分隔符差异会让宿主找不到目标会话。
 */
export function canonicalOwnerKey(key: string): string {
  if (isDraftOwnerKey(key)) return key;
  return key.replace(/\\/g, '/').replace(/^\/\/\?\//, '').replace(/\/+$/, '').toLowerCase();
}
