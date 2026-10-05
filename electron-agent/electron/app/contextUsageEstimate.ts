/**
 * pi 在压缩完成后、下一条助手回复到来前，会把 contextUsage.tokens 置为 null：
 * 最后一条 usage 还是压缩前的窗口，直接拿来画会虚高。这里用 pi 自己的 chars/4
 * 启发式，按当前上下文（系统提示 + 压缩后仍留在窗口里的消息）补一个可展示的估计。
 */

const ESTIMATED_IMAGE_CHARS = 4800;

export interface ContextUsageSnapshot {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface SessionStatsSnapshot {
  contextUsage?: ContextUsageSnapshot;
}

export interface LiveContextInput {
  messages?: readonly unknown[];
  systemPrompt?: string;
}

function textChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const item = block as { type?: unknown; text?: unknown };
    if (item.type === 'text' && typeof item.text === 'string') chars += item.text.length;
    else if (item.type === 'image') chars += ESTIMATED_IMAGE_CHARS;
  }
  return chars;
}

/** 单条消息的 chars/4 估计，与 pi compaction.estimateTokens 对齐。 */
export function estimateAgentMessageTokens(message: unknown): number {
  if (!message || typeof message !== 'object') return 0;
  const msg = message as {
    role?: unknown;
    content?: unknown;
    summary?: unknown;
    command?: unknown;
    output?: unknown;
    sections?: unknown;
    toolsAdded?: unknown;
  };
  let chars = 0;
  try {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== 'object') continue;
        const item = block as { type?: unknown; text?: unknown; thinking?: unknown; name?: unknown; arguments?: unknown };
        if (item.type === 'text' && typeof item.text === 'string') chars += item.text.length;
        else if (item.type === 'thinking' && typeof item.thinking === 'string') chars += item.thinking.length;
        else if (item.type === 'toolCall') {
          const name = typeof item.name === 'string' ? item.name.length : 0;
          chars += name + JSON.stringify(item.arguments ?? {}).length;
        }
      }
    } else if (msg.role === 'compactionSummary' || msg.role === 'branchSummary') {
      chars = typeof msg.summary === 'string' ? msg.summary.length : 0;
    } else if (msg.role === 'bashExecution') {
      chars = String(msg.command ?? '').length + String(msg.output ?? '').length;
    } else if (msg.role === 'system') {
      chars = textChars(msg.content);
      if (msg.sections && typeof msg.sections === 'object') {
        for (const section of Object.values(msg.sections as Record<string, unknown>)) {
          if (typeof section === 'string') chars += section.length;
        }
      }
      if (msg.toolsAdded != null) chars += JSON.stringify(msg.toolsAdded).length;
    } else {
      chars = textChars(msg.content);
    }
  } catch {
    return 0;
  }
  return Math.ceil(chars / 4);
}

export function estimateLiveContextTokens(input: LiveContextInput): number {
  const messages = input.messages ?? [];
  const hasSystem = messages.some(
    (message) => !!message && typeof message === 'object' && (message as { role?: unknown }).role === 'system',
  );
  const prompt = !hasSystem && typeof input.systemPrompt === 'string' ? input.systemPrompt : '';
  let tokens = prompt ? Math.ceil(prompt.length / 4) : 0;
  for (const message of messages) tokens += estimateAgentMessageTokens(message);
  return tokens;
}

/** tokens 为 null 时用当前上下文估计填上；已有用量或窗口未知时原样返回。 */
export function withEstimatedContextUsage<T extends SessionStatsSnapshot>(stats: T, input: LiveContextInput): T {
  const usage = stats.contextUsage;
  if (!usage || usage.tokens != null || !(usage.contextWindow > 0)) return stats;
  const tokens = estimateLiveContextTokens(input);
  if (tokens <= 0) return stats;
  return {
    ...stats,
    contextUsage: {
      tokens,
      contextWindow: usage.contextWindow,
      percent: (tokens / usage.contextWindow) * 100,
    },
  };
}
