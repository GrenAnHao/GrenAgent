import type { ChatMessage } from './agentReducer';

/**
 * UI 完整历史（前端持久化的 ui-history）与后端快照合并时的来源补齐。
 *
 * 背景：pi 压缩会让后端 `get_messages` 变短，界面优先显示更长的 ui-history；但迁移前写下的旧
 * ui-history 行没有 `sourceCwd` / `sourceRefs`。迁移后如果直接显示它们，历史文件 / 图片入口会把
 * 相对路径按**目标项目**重新解释，等于把旧引用指到目标同名文件。
 *
 * 规则：
 * - 后端行（迁移后由 workflowHistoryMessages 提供完整来源）按 entryId / toolCallId / 时间戳贴回 ui-history；
 * - 已经带 sourceCwd / sourceRefs 的旧行优先保留（往返迁移不覆盖更具体的旧来源）；
 * - 找不到映射的辅助条目用本次迁移的 fromWorkspace 兜底，不让它退回「当前项目」；
 * - 只补来源字段，正文、参数、状态、id 一律不动。
 */

type SourcePatch = { sourceCwd?: string; sourceRefs?: Record<string, string> };

type Sourced = Extract<ChatMessage, { kind: 'user' | 'assistant' | 'tool' }>;

/** 只有 user / assistant / tool 这几类带来源字段；通知、压缩分隔等辅助条目没有可写的来源位。 */
function isSourced(message: ChatMessage): message is Sourced {
  return message.kind === 'user' || message.kind === 'assistant' || message.kind === 'tool';
}

function sourceOf(message: ChatMessage): SourcePatch {
  if (!isSourced(message)) return {};
  const out: SourcePatch = {};
  if (typeof message.sourceCwd === 'string' && message.sourceCwd.trim()) out.sourceCwd = message.sourceCwd;
  if (message.kind === 'tool' && message.sourceRefs && Object.keys(message.sourceRefs).length > 0) {
    out.sourceRefs = message.sourceRefs;
  }
  return out;
}

function timestampOf(message: ChatMessage): number | undefined {
  if (message.kind === 'notice') return message.sourceTimestamp;
  if (message.kind === 'user' || message.kind === 'assistant') return message.timestamp;
  return undefined;
}

interface ProvenanceIndex {
  byEntryId: Map<string, SourcePatch>;
  byToolCallId: Map<string, SourcePatch>;
  byTimestamp: Map<number, SourcePatch>;
  byToolTimestamp: Map<number, SourcePatch>;
}

function indexOf(backend: readonly ChatMessage[]): ProvenanceIndex {
  const byEntryId = new Map<string, SourcePatch>();
  const byToolCallId = new Map<string, SourcePatch>();
  const byTimestamp = new Map<number, SourcePatch>();
  const byToolTimestamp = new Map<number, SourcePatch>();
  for (const message of backend) {
    const source = sourceOf(message);
    if (!source.sourceCwd && !source.sourceRefs) continue;
    if (isSourced(message) && typeof message.entryId === 'string' && message.entryId) {
      byEntryId.set(message.entryId, source);
    }
    if (message.kind === 'tool' && message.toolCallId) {
      byToolCallId.set(message.toolCallId, source);
      const stamp = toolTimestampOf(message);
      if (stamp !== undefined) byToolTimestamp.set(stamp, source);
    } else {
      const stamp = timestampOf(message);
      if (stamp !== undefined) byTimestamp.set(stamp, source);
    }
  }
  return { byEntryId, byToolCallId, byTimestamp, byToolTimestamp };
}

/** 工具的稳定时间键：有些投影会给工具卡带 timestamp（历史行本来就有），没有就退回 startedAt。 */
function toolTimestampOf(message: Extract<ChatMessage, { kind: 'tool' }>): number | undefined {
  const raw = (message as { timestamp?: unknown }).timestamp;
  if (typeof raw === 'number') return raw;
  return typeof message.startedAt === 'number' ? message.startedAt : undefined;
}

function keyOf(message: ChatMessage): string | undefined {
  if (isSourced(message) && typeof message.entryId === 'string' && message.entryId) return message.entryId;
  if (message.kind === 'tool' && message.toolCallId) return `tool:${message.toolCallId}`;
  const stamp = timestampOf(message) ?? (message.kind === 'tool' ? toolTimestampOf(message) : undefined);
  return stamp === undefined ? undefined : `ts:${stamp}`;
}

export interface EnrichedHistory {
  messages: ChatMessage[];
  /** 有任何一条补了来源字段：需要写回 ui-history，避免下次重挂又丢。 */
  changed: boolean;
}

/**
 * 给 ui-history 行贴回来源。`fallbackSource` 是迁移的源项目（fromWorkspace）；
 * 已经带来源的行原样保留，绝不因为又一次迁移改写旧映射。
 */
export function enrichHistorySources(
  history: readonly ChatMessage[],
  backend: readonly ChatMessage[],
  fallbackSource?: string,
): EnrichedHistory {
  const index = indexOf(backend);
  const nearestTool = (stamp: number): SourcePatch | undefined => {
    // 辅助工具卡（前端合成、后端不存在的行）没有 toolCallId：取时间上最近的、带来源的后端工具。
    let best: { source: SourcePatch; distance: number } | undefined;
    for (const [candidate, source] of index.byToolTimestamp) {
      const distance = Math.abs(candidate - stamp);
      if (!best || distance < best.distance) best = { source, distance };
    }
    return best?.source;
  };
  let changed = false;
  const messages = history.map((message) => {
    if (!isSourced(message)) return message;
    const hasCwd = typeof message.sourceCwd === 'string' && message.sourceCwd.trim();
    const hasRefs = message.kind === 'tool' && message.sourceRefs && Object.keys(message.sourceRefs).length > 0;
    if (hasCwd && (message.kind !== 'tool' || hasRefs)) return message;
    const entryId = typeof message.entryId === 'string' ? message.entryId : undefined;
    const stamp = message.kind === 'tool' ? toolTimestampOf(message) : timestampOf(message);
    const source =
      (entryId ? index.byEntryId.get(entryId) : undefined) ??
      (message.kind === 'tool' && message.toolCallId ? index.byToolCallId.get(message.toolCallId) : undefined) ??
      (message.kind === 'tool'
        ? stamp !== undefined
          ? index.byToolTimestamp.get(stamp) ?? nearestTool(stamp)
          : undefined
        : stamp !== undefined
          ? index.byTimestamp.get(stamp)
          : undefined);
    const cwd = source?.sourceCwd ?? (hasCwd ? undefined : fallbackSource);
    const refs = source?.sourceRefs;
    if (!cwd && !refs) return message;
    const next: ChatMessage =
      message.kind === 'tool'
        ? {
            ...message,
            ...(message.sourceCwd || !cwd ? {} : { sourceCwd: cwd }),
            ...(message.sourceRefs && Object.keys(message.sourceRefs).length > 0 ? {} : refs ? { sourceRefs: { ...refs } } : {}),
          }
        : { ...message, ...(message.sourceCwd || !cwd ? {} : { sourceCwd: cwd }) };
    const sameCwd = message.sourceCwd === next.sourceCwd;
    const sameRefs =
      message.kind !== 'tool' ||
      JSON.stringify(message.sourceRefs ?? null) === JSON.stringify(next.kind === 'tool' ? next.sourceRefs ?? null : null);
    if (sameCwd && sameRefs) return message;
    changed = true;
    return next;
  });
  return { messages, changed };
}

/**
 * ui-history 里存在、后端快照里已经找不到的旧辅助条目：迁移时它们的来源只能按 fromWorkspace 兜底。
 * 这里只用于判定「是否还有引用原项目目录的条目」，帮助调用方决定保留源 scratch 保留根；
 * 渲染侧不改写这些条目。返回涉及的原始来源集合。
 */
export function unresolvedHistorySources(history: readonly ChatMessage[]): string[] {
  const roots = new Set<string>();
  for (const message of history) {
    const source = sourceOf(message);
    if (source.sourceCwd) roots.add(source.sourceCwd);
    for (const root of Object.values(source.sourceRefs ?? {})) if (root.trim()) roots.add(root);
  }
  return [...roots];
}

/** 这批 ui-history 是否已全部指向某个项目（用于避免把目标项目的行再贴回旧来源）。 */
export function historyBelongsTo(history: readonly ChatMessage[], workspace: string): boolean {
  return history.every((message) => {
    const cwd = sourceOf(message).sourceCwd;
    if (!cwd) return true;
    return cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() ===
      workspace.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  });
}

/** 测试 / 诊断：暴露 key 规则，保证与 ui-history 写回一致。 */
export const historyMessageKey = keyOf;
