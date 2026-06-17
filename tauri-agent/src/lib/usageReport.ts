// 跨会话用量报表(对应 Rust usage_report 命令的返回,camelCase)。

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  sessions: number;
  messages: number;
  /** cacheRead / (input + cacheRead),0–1 */
  cacheHitRate: number;
}

export interface DayUsage {
  date: string;
  tokens: number;
  cost: number;
}

export interface ModelUsage {
  model: string;
  provider: string;
  tokens: number;
  cost: number;
  messages: number;
}

export interface ProjectUsage {
  cwd: string;
  name: string | null;
  tokens: number;
  cost: number;
  sessions: number;
}

export interface SessionUsage {
  id: string;
  name: string | null;
  cwd: string | null;
  path: string;
  timestamp: string | null;
  tokens: number;
  cost: number;
}

/** 单次模型调用(一条 assistant 消息)的用量明细。 */
export interface CallUsage {
  timestamp: string | null;
  model: string;
  provider: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export interface UsageReport {
  totals: UsageTotals;
  byDay: DayUsage[];
  byModel: ModelUsage[];
  byProject: ProjectUsage[];
  recentSessions: SessionUsage[];
  calls: CallUsage[];
}
