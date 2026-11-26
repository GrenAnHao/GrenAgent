/** Pure report contract shared by the SQLite reader and desktop renderer. */
export type CostSource = "provider" | "catalog" | "unknown";
export type UsageRange = "7d" | "30d" | "all";
export interface UsageFilters { range?: UsageRange; projectId?: string; includeAllSessions?: boolean }
export const CALL_PAGE_SIZE = 20;
export interface CallQuery extends UsageFilters { page: number; provider?: string; model?: string }
export interface CallPage { rows: CallUsage[]; total: number; page: number; providers: string[]; models: string[] }
export function readCallQuery(value: unknown): CallQuery {
  const filters = readUsageFilters(value);
  const {page, model, provider} = (value ?? {}) as Partial<CallQuery>;
  if (!Number.isSafeInteger(page) || page! < 1 || (model !== undefined && typeof model !== 'string') ||
    (provider !== undefined && typeof provider !== 'string')) throw new Error('Invalid usage call query');
  return {...filters, page:page!, model, provider};
}
export interface UsageProject { projectId: string; name: string }

export function readUsageFilters(value: unknown): UsageFilters {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid usage filters");
  const { range, projectId, includeAllSessions } = value as Record<string, unknown>;
  if (range !== undefined && range !== "all" && range !== "7d" && range !== "30d") throw new Error("Invalid usage range");
  if (projectId !== undefined && (typeof projectId !== "string" || !projectId)) throw new Error("Invalid usage project");
  if (includeAllSessions !== undefined && typeof includeAllSessions !== "boolean") throw new Error("Invalid usage session scope");
  return { ...(range ? { range } : {}), ...(projectId === undefined ? {} : { projectId }), ...(includeAllSessions ? { includeAllSessions } : {}) };
}

/** Older title generators sometimes persisted their entire response instead of its title. */
export function cleanUsageTitle(value: string | null | undefined): string | null {
  const title = value?.trim();
  if (!title) return null;
  if (!title.startsWith("{") || !title.includes('"title"')) return title;
  try {
    const parsed: unknown = JSON.parse(title);
    if (parsed && typeof parsed === "object" && "title" in parsed && typeof parsed.title === "string") return parsed.title.trim() || null;
  } catch { /* Never print a malformed title envelope in usage analytics. */ }
  return null;
}

export function standardUsageModel(provider: string, value: string): string {
  const id = value.trim().normalize("NFKC").toLowerCase();
  // A provider-qualified request may repeat the provider or include the model's native vendor.
  // Keep namespace-qualified custom model IDs intact when the namespace is part of the model identity.
  const parts = id.split("/");
  if (parts.length > 1 && parts[0] === provider.trim().toLowerCase()) parts.shift();
  if (parts.length === 2 && ((parts[0] === "openai" && /^(?:gpt-|o[1-9](?:-|$))/.test(parts[1])) ||
    (parts[0] === "anthropic" && parts[1].startsWith("claude-")) || (parts[0] === "google" && parts[1].startsWith("gemini-")))) parts.shift();
  return parts.join("/") || "未知模型";
}

export interface UsageTotals {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
  cost: number; sessions: number; messages: number;
  /** Assistant cacheRead / (input + cacheRead), 0–1. */
  cacheHitRate: number;
}

interface DimensionUsage {
  /** Assistant usage only; independent cache warming does not create assistant tokens or calls. */
  tokens: number; cost: number;
  /** All recorded dollars (assistant + attributed warming), not necessarily provider-reported. */
  recordedCost: number;
}
export interface DayUsage extends DimensionUsage { date: string; messages: number; cacheHitRate: number }
export interface ModelUsage extends DimensionUsage { model: string; provider: string; messages: number }
export interface ProjectUsage extends DimensionUsage, UsageProject { cwd: string; sessions: number }
export interface SessionUsage {
  id: string; name: string | null; cwd: string | null; path: string; timestamp: string | null; tokens: number; cost: number;
  /** Project identity supplied with the desktop's full, sortable session summaries. */
  projectId?: string;
}
export interface CallUsage {
  responseModel?: string | null; costSource?: CostSource; timestamp: string | null;
  model: string; provider: string; input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number;
}
export interface WarmUsage {
  sessionId: string; entryId: string; timestamp: string; kind: "cache_warm"; provider: string; attributedModel: string;
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number; costSource: CostSource;
}
export interface UsageReport {
  projects: UsageProject[];
  totals: UsageTotals; byDay: DayUsage[]; byModel: ModelUsage[]; byProject: ProjectUsage[];
  recentSessions: SessionUsage[]; calls: CallUsage[];
  // Older desktop reports did not record separate warming usage or cost provenance.
  warmingTotals?: { cost: number; messages: number; totalTokens: number };
  warmingCalls?: WarmUsage[];
  recordedCost?: { assistantCost: number; warmingCost: number; totalCost: number; sourceBreakdown: Record<CostSource, number> };
}
