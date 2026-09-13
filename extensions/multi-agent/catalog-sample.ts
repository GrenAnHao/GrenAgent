import { existsSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getActivationBySessionPath } from "./activation.js";
import { foldCatalog, type SubagentCatalogEntry } from "./catalog.js";

export type CatalogActivity = "running" | "idle" | "ready" | "settled" | "unavailable";

export interface CatalogRowView extends SubagentCatalogEntry {
  activity: CatalogActivity;
  hasChildren: boolean;
  tokens?: number;
  durationMs?: number;
  diagnostic?: "corrupt" | "unavailable";
}

type SessionEntry = {
  type?: string;
  customType?: string;
  data?: Record<string, unknown>;
};

type MessageLike = {
  role?: unknown;
  timestamp?: unknown;
  usage?: unknown;
};

type BusySession = {
  isStreaming?: unknown;
  isCompacting?: unknown;
  isIdle?: unknown;
};

function lastSubagentMeta(entries: unknown[]): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  if (!Array.isArray(entries)) return undefined;
  for (const entry of entries) {
    const item = entry as SessionEntry;
    if (item?.type === "custom" && item.customType === "subagent_meta" && item.data && typeof item.data === "object") {
      found = item.data;
    }
  }
  return found;
}

function inheritedEventCount(meta: Record<string, unknown> | undefined): number {
  const n = meta?.inheritedEventCount;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function isResidentIdle(session: BusySession): boolean {
  if (typeof session.isIdle === "boolean") return session.isIdle;
  return session.isStreaming !== true && session.isCompacting !== true;
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageTokens(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  return numberField(u.input) + numberField(u.output) + numberField(u.cacheRead) + numberField(u.cacheWrite);
}

function messageTimestamp(message: MessageLike): number | undefined {
  const ts = message.timestamp;
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function isEndRole(role: unknown): boolean {
  return role === "assistant" || role === "toolResult" || role === "tool";
}

function sampleSlice(messages: unknown[]): { tokens?: number; firstUser?: number; lastEnd?: number } {
  let tokens: number | undefined;
  let firstUser: number | undefined;
  let lastEnd: number | undefined;
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as MessageLike;
    const ts = messageTimestamp(message);
    if (message.role === "user" && firstUser === undefined && ts !== undefined) firstUser = ts;
    if (isEndRole(message.role) && ts !== undefined) lastEnd = ts;
    const part = usageTokens(message.usage);
    if (part !== undefined) tokens = (tokens ?? 0) + part;
  }
  return { tokens, firstUser, lastEnd };
}

function openChild(sessionPath: string): { messages: unknown[]; meta?: Record<string, unknown> } | undefined {
  try {
    if (!existsSync(sessionPath)) return undefined;
    const sm = SessionManager.open(sessionPath);
    return {
      messages: sm.buildSessionContext().messages as unknown[],
      meta: lastSubagentMeta(sm.getEntries()),
    };
  } catch {
    return undefined;
  }
}

export function sampleCatalogRow(entry: SubagentCatalogEntry, opts?: { now?: number }): CatalogRowView {
  const activation = getActivationBySessionPath(entry.sessionPath);
  let opened: { messages: unknown[]; meta?: Record<string, unknown> } | undefined;
  try {
    opened = openChild(entry.sessionPath);
  } catch {
    opened = undefined;
  }

  let activity: CatalogActivity;
  let diagnostic: CatalogRowView["diagnostic"];
  if (activation) {
    activity = isResidentIdle(activation.session as BusySession) ? "idle" : "running";
  } else if (!opened) {
    activity = "unavailable";
    diagnostic = "unavailable";
  } else if (entry.mode === "continuable" && opened.meta?.tornDown !== true) {
    activity = "ready";
  } else {
    activity = "settled";
  }

  let hasChildren = false;
  try {
    hasChildren = foldCatalog(entry.sessionPath).entries.length > 0;
  } catch {
    hasChildren = false;
  }

  const row: CatalogRowView = {
    ...entry,
    activity,
    hasChildren,
  };
  if (diagnostic) row.diagnostic = diagnostic;
  if (!opened) return row;

  let sampled: { tokens?: number; firstUser?: number; lastEnd?: number };
  try {
    sampled = sampleSlice(opened.messages.slice(inheritedEventCount(opened.meta)));
  } catch {
    if (!activation) {
      row.activity = "unavailable";
      row.diagnostic = "unavailable";
    }
    return row;
  }

  if (sampled.tokens !== undefined) row.tokens = sampled.tokens;
  const start = sampled.firstUser;
  const end = activity === "running" ? (opts?.now ?? Date.now()) : sampled.lastEnd;
  if (start !== undefined && end !== undefined) row.durationMs = end - start;
  return row;
}
