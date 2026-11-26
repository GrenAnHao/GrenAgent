import { remoteTransportKind, transportOf, type McpConfig, type McpRemoteConfig, type McpStdioConfig } from './mcpConfig';

import type { CatalogTool } from '../../../../extensions/mcp/catalog';
export interface CacheEntry {
  catalog?: CatalogTool[];
  stderr?: string[];
  exit?: string;
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
      ...(Array.isArray(raw.catalog) && { catalog: raw.catalog.filter((t): t is CatalogTool => isRecord(t) && typeof t.fullName === 'string' && typeof t.name === 'string' && (t.description === undefined || typeof t.description === 'string')) }),
      ...(Array.isArray(raw.stderr) && { stderr: strArray(raw.stderr).slice(-10) }),
      ...(typeof raw.exit === 'string' && { exit: raw.exit }),
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
  const entry = cache[name];
  return entry && !entry.ok && !entry.toolNames.length ? entry.catalog?.map(tool => tool.fullName) ?? [] : entry?.toolNames ?? [];
}

export function toProbeConfigJson(name: string, config: McpConfig): string {
  if (transportOf(config) === 'stdio') {
    const s = config as McpStdioConfig;
    return JSON.stringify({ name, transport: 'stdio', command: s.command, args: s.args ?? [], env: s.env ?? {}, ...(s.cwd && { cwd: s.cwd }) });
  }
  const r = config as McpRemoteConfig;
  const headers = r.headers && Object.keys(r.headers).length ? { headers: r.headers } : {};
  return JSON.stringify({
    name,
    transport: remoteTransportKind(r.url),
    url: r.url,
    ...headers,
  });
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
