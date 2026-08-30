export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface SessionStats {
  sessionFile?: string;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: ContextUsage;
}

export interface ContextStats {
  contextUsed: number | null;
  contextLimit: number;
  contextPercent: number;
  contextKnown: boolean;
  contextStatus: 'unknown' | 'normal' | 'warning' | 'danger';
  tokens: SessionStats['tokens'];
  cost: number;
  sessionId: string;
  sessionFile?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
}

export function mapSessionStats(stats: SessionStats): ContextStats {
  const usage = stats.contextUsage;
  const contextLimit = usage?.contextWindow ?? 0;
  const contextKnown = usage != null && usage.tokens !== null;
  const contextUsed = usage?.tokens ?? null;
  const rawPercent = usage?.percent ?? (contextKnown && contextLimit > 0
    ? ((contextUsed as number) / contextLimit) * 100
    : 0);
  const contextPercent = Math.min(100, Math.max(0, rawPercent ?? 0));

  let contextStatus: ContextStats['contextStatus'] = 'normal';
  if (!contextKnown) contextStatus = 'unknown';
  else if (contextPercent >= 90) contextStatus = 'danger';
  else if (contextPercent >= 70) contextStatus = 'warning';

  return {
    contextUsed,
    contextLimit,
    contextPercent,
    contextKnown,
    contextStatus,
    tokens: stats.tokens,
    cost: stats.cost,
    sessionId: stats.sessionId,
    sessionFile: stats.sessionFile,
    userMessages: stats.userMessages,
    assistantMessages: stats.assistantMessages,
    toolCalls: stats.toolCalls,
  };
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export interface ContextBreakdownItem {
  id: string;
  label: string;
  tokens: number;
  /** 占上下文窗口的百分比（0–100） */
  percent: number;
  colorClass: string;
  /** context = 窗口占用；session = 会话累计统计 */
  group: 'context' | 'session';
  /** 展开列表右侧附加信息（如消息条数） */
  meta?: string;
}

function windowPercent(tokens: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min(100, Math.max(0, (tokens / limit) * 100));
}

/** 构建展开详情中的分项列表（pi 无 Cursor 级细粒度，按可用字段诚实展示）。 */
export function buildContextBreakdown(stats: ContextStats): ContextBreakdownItem[] {
  const limit = stats.contextLimit;
  const items: ContextBreakdownItem[] = [];

  if (stats.contextKnown && stats.contextUsed != null && limit > 0) {
    const used = stats.contextUsed;
    const free = Math.max(0, limit - used);
    items.push({
      id: 'used',
      label: '上下文占用',
      tokens: used,
      percent: windowPercent(used, limit),
      colorClass: 'ctx-seg-used',
      group: 'context',
    });
    items.push({
      id: 'free',
      label: '剩余空间',
      tokens: free,
      percent: windowPercent(free, limit),
      colorClass: 'ctx-seg-free',
      group: 'context',
    });
  }

  const tok = stats.tokens;
  if (tok.cacheRead > 0) {
    items.push({
      id: 'cache-read',
      label: 'Cache Read（累计）',
      tokens: tok.cacheRead,
      percent: windowPercent(tok.cacheRead, limit),
      colorClass: 'ctx-seg-cache-read',
      group: 'session',
    });
  }
  if (tok.cacheWrite > 0) {
    items.push({
      id: 'cache-write',
      label: 'Cache Write（累计）',
      tokens: tok.cacheWrite,
      percent: windowPercent(tok.cacheWrite, limit),
      colorClass: 'ctx-seg-cache-write',
      group: 'session',
    });
  }
  if (tok.input > 0) {
    items.push({
      id: 'input',
      label: 'Input（累计）',
      tokens: tok.input,
      percent: windowPercent(tok.input, limit),
      colorClass: 'ctx-seg-input',
      group: 'session',
    });
  }
  if (tok.output > 0) {
    items.push({
      id: 'output',
      label: 'Output（累计）',
      tokens: tok.output,
      percent: windowPercent(tok.output, limit),
      colorClass: 'ctx-seg-output',
      group: 'session',
    });
  }

  items.push({
    id: 'user-msgs',
    label: '用户消息',
    tokens: 0,
    percent: 0,
    colorClass: 'ctx-seg-meta',
    group: 'session',
    meta: String(stats.userMessages),
  });
  items.push({
    id: 'assistant-msgs',
    label: '助手消息',
    tokens: 0,
    percent: 0,
    colorClass: 'ctx-seg-meta',
    group: 'session',
    meta: String(stats.assistantMessages),
  });
  items.push({
    id: 'tool-calls',
    label: '工具调用',
    tokens: 0,
    percent: 0,
    colorClass: 'ctx-seg-meta',
    group: 'session',
    meta: String(stats.toolCalls),
  });

  return items;
}
