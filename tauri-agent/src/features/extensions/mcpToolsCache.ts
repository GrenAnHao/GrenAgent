import { transportOf, type McpConfig, type McpRemoteConfig, type McpStdioConfig } from './mcpConfig';

export interface CacheEntry {
  toolNames: string[];
  probedAt: string;
  ok: boolean;
  error?: string;
}

export interface ProbeResult {
  ok: boolean;
  toolNames: string[];
  error?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function parseToolsCache(json: string): Record<string, CacheEntry> {
  if (!json.trim()) return {};
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return {};
  }
  if (!isRecord(v)) return {};
  const out: Record<string, CacheEntry> = {};
  for (const [name, raw] of Object.entries(v)) {
    if (!isRecord(raw)) continue;
    out[name] = {
      toolNames: strArray(raw.toolNames),
      probedAt: typeof raw.probedAt === 'string' ? raw.probedAt : '',
      ok: raw.ok === true,
      ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
    };
  }
  return out;
}

export function getCacheEntry(cache: Record<string, CacheEntry>, name: string): CacheEntry | undefined {
  return cache[name];
}

export function getCachedTools(cache: Record<string, CacheEntry>, name: string): string[] {
  return cache[name]?.toolNames ?? [];
}

export function toProbeConfigJson(name: string, config: McpConfig): string {
  if (transportOf(config) === 'stdio') {
    const s = config as McpStdioConfig;
    return JSON.stringify({ name, transport: 'stdio', command: s.command, args: s.args ?? [], env: s.env ?? {} });
  }
  const r = config as McpRemoteConfig;
  return JSON.stringify({ name, transport: 'sse', url: r.url });
}

export function parseProbeResult(json: string): ProbeResult {
  try {
    const v = JSON.parse(json);
    if (isRecord(v) && typeof v.ok === 'boolean') {
      return { ok: v.ok, toolNames: strArray(v.toolNames), ...(typeof v.error === 'string' ? { error: v.error } : {}) };
    }
  } catch {
    // fall through
  }
  return { ok: false, toolNames: [], error: 'invalid probe result' };
}
