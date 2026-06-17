// 从子代理的能力档案（registry 里存的 resolveProfile JSON）推断「类型」：
// - preset：预设名（explore/planner/executor/reviewer/default，或 inline 时为 custom）
// - access：文件系统访问级别（readonly = 只读、write = 可写）
// - restricted：是否为受限写（仅允许部分前缀，如 planner 的 writeAllow）
// 纯函数，无副作用，便于单测。

export type SubAgentAccess = 'readonly' | 'write';

export interface SubAgentTypeInfo {
  preset: string;
  access: SubAgentAccess;
  restricted: boolean;
}

const PRESET_LABELS: Record<string, string> = {
  default: '默认',
  explore: '探索',
  planner: '规划',
  executor: '执行',
  reviewer: '审查',
  custom: '自定义',
};

const FALLBACK: SubAgentTypeInfo = { preset: 'default', access: 'write', restricted: false };

/** 未设档案（registry profile 为 null）等同跑默认档案 default（可写工作区）。 */
export function parseSubAgentType(profileJson: string | null | undefined): SubAgentTypeInfo {
  if (!profileJson) return { ...FALLBACK };
  let parsed: unknown;
  try {
    parsed = JSON.parse(profileJson);
  } catch {
    return { ...FALLBACK };
  }
  if (!parsed || typeof parsed !== 'object') return { ...FALLBACK };

  const obj = parsed as { name?: unknown; fs?: unknown };
  const preset = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : 'custom';
  const fs = obj.fs;

  if (fs === 'readonly') return { preset, access: 'readonly', restricted: false };
  if (fs && typeof fs === 'object' && Array.isArray((fs as { writeAllow?: unknown }).writeAllow)) {
    return { preset, access: 'write', restricted: true };
  }
  return { preset, access: 'write', restricted: false };
}

/** 预设名的中文显示（未知预设回退为原名）。 */
export function presetLabel(preset: string): string {
  return PRESET_LABELS[preset] ?? preset;
}

/** 访问级别的中文短标签（只读 / 受限写 / 工作）。 */
export function accessLabel(info: SubAgentTypeInfo): string {
  if (info.access === 'readonly') return '只读';
  return info.restricted ? '受限写' : '工作';
}
