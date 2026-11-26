import type { CatalogTool } from '../../../../extensions/mcp/catalog';
import { exposureForTool } from '../../../../extensions/mcp/exposure';
import { definitionChars, type ToolFootprint } from '../../../../extensions/mcp/definitionSize';
import type { McpServerStatus } from '../../stores/mcpStatusStore';
import type { McpEntry } from './mcpConfig';
import { getToolPerm, shortToolName } from './mcpPolicy';
import { getCachedTools, type CacheEntry } from './mcpToolsCache';

export function tokens(chars: number) {
  const n = Math.ceil(chars / 4);
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function toolBudget(names: string[], catalog: Map<string, CatalogTool>, enabled: boolean, policy: Record<string, unknown>, exposure = 'codemode', overrides: Record<string, string> = {}, footprints?: ToolFootprint[]) {
  let available = 0, permittedChars = 0, directChars = 0, partial = false;
  if (enabled) names.forEach((full, i) => {
    const tool = catalog.get(full);
    const measured = footprints?.[i];
    const chars = measured?.[0] ?? definitionChars(full, tool);
    const visibility = measured?.[1] ?? exposureForTool(tool?.name ?? shortToolName(full), {exposure, toolExposure:overrides});
    if (!measured && !tool && visibility !== 'hidden') partial = true;
    if (visibility !== 'hidden' && getToolPerm(policy, full) !== 'disabled') { available++; permittedChars += chars; }
    if (visibility === 'direct') directChars += chars;
  });
  return { available, permittedChars, directChars, partial, permitted: tokens(permittedChars), direct: tokens(directChars) };
}

export function workspaceBudget(entries: McpEntry[], servers: McpServerStatus[], cache: Record<string, CacheEntry>, policy: Record<string, unknown>) {
  const live = new Map(servers.map(s => [s.name, s]));
  const byServer = new Map<string, ReturnType<typeof toolBudget>>();
  let enabled = 0, available = 0, directChars = 0, permittedChars = 0, partial = false;
  const configured = new Map(entries.map(e => [e.name,e]));
  for (const name of new Set([...configured.keys(), ...live.keys()])) {
    const entry = configured.get(name);
    if (entry && !entry.enabled) continue;
    enabled++;
    const server = live.get(name), online = server?.status === 'connected';
    const names = online ? server.toolNames ?? [] : getCachedTools(cache, name);
    const config = (entry?.config ?? {}) as {exposure?: string; toolExposure?: Record<string,string>};
    const known = new Map(cache[name]?.catalog?.map(t => [t.fullName,t]));
    const b = toolBudget(names, known, true, policy, server?.exposure ?? config.exposure, config.toolExposure, online ? server.footprints : undefined);
    byServer.set(name, b);
    available += b.available; permittedChars += b.permittedChars;
    if (online) directChars += b.directChars;
    partial ||= b.partial || (!online && !cache[name]?.ok) || (online && names.length !== server.tools);
  }
  return { byServer, enabled, available, direct: tokens(directChars), permitted: tokens(permittedChars), partial };
}
