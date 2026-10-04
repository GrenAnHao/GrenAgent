import { execSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

export type McpExposure = "codemode" | "deferred" | "direct" | "hidden";

const EXPOSURES = new Set<McpExposure>(["codemode", "deferred", "direct", "hidden"]);

export interface McpMergeServer {
  name: string;
  transport?: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
  exposure?: string;
  toolExposure?: Record<string, string>;
  description?: string;
  timeout?: number;
  oauth?: unknown;
  auth?: unknown;
}

export interface McpMergeLayersInput {
  desktop: McpMergeServer[];
  global: McpMergeServer[];
  project: McpMergeServer[];
  globalDisabled: string[];
  projectDisabled: string[];
  globalAutoEnableCodemode: boolean | undefined;
  projectAutoEnableCodemode: boolean | undefined;
}

export interface McpMergeResult {
  servers: McpMergeServer[];
  errors: string[];
  autoEnableCodemode: boolean;
}

export interface ExpandConfigInput {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  url?: string;
  cwd?: string;
}

export interface ExpandConfigContext {
  home: string;
  sessionCwd: string;
  [name: string]: string | undefined;
}

export function normalizeExposure(value: unknown): McpExposure | undefined {
  if (value === undefined) return "codemode";
  if (value === "codemode-deferred") return "codemode";
  if (typeof value === "string" && EXPOSURES.has(value as McpExposure)) return value as McpExposure;
  return undefined;
}

export function mergeMcpLayers(input: McpMergeLayersInput): McpMergeResult {
  const map = new Map<string, McpMergeServer>();
  const errors: string[] = [];
  for (const entry of input.desktop) map.set(entry.name, { ...entry });
  for (const entry of input.global) map.set(entry.name, { ...entry });
  for (const entry of input.project) applyProjectEntry(map, entry, errors);

  const disabled = new Set([...input.globalDisabled, ...input.projectDisabled]);
  for (const name of [...map.keys()]) {
    const server = map.get(name);
    if (server && (disabled.has(name) || server.enabled === false)) map.delete(name);
  }

  const servers: McpMergeServer[] = [];
  for (const server of map.values()) {
    const exposure = normalizeExposure(server.exposure);
    if (exposure === undefined) {
      errors.push(`服务器 ${server.name} 的 exposure 无效`);
      continue;
    }
    servers.push({ ...server, exposure });
  }

  return {
    servers,
    errors,
    autoEnableCodemode: input.projectAutoEnableCodemode ?? input.globalAutoEnableCodemode ?? true,
  };
}

export function exposureForTool(
  toolName: string,
  server: { exposure?: string; toolExposure?: Record<string, string> },
): McpExposure {
  const table = server.toolExposure;
  if (table && Object.prototype.hasOwnProperty.call(table, toolName)) {
    const exact = normalizeListedExposure(table[toolName]);
    if (exact) return exact;
  }
  if (table) {
    for (const [pattern, value] of Object.entries(table)) {
      if (!pattern.includes("*") || !exposurePatternMatches(pattern, toolName)) continue;
      const matched = normalizeListedExposure(value);
      if (matched) return matched;
    }
  }
  return normalizeListedExposure(server.exposure) ?? "codemode";
}

export function expandConfigValues<T extends ExpandConfigInput>(config: T, context: ExpandConfigContext): T {
  const expand = (value: string) => expandConfigString(value, context);
  const next = { ...config };
  if (typeof config.command === "string") next.command = expand(config.command);
  if (config.args) next.args = config.args.map(expand);
  if (config.env) next.env = mapValues(config.env, expand);
  if (config.headers) next.headers = mapValues(config.headers, expand);
  if (typeof config.url === "string") next.url = expand(config.url);
  if (typeof config.cwd === "string") next.cwd = expandCwd(expand(config.cwd), context.home, context.sessionCwd);
  return next;
}

function applyProjectEntry(map: Map<string, McpMergeServer>, entry: McpMergeServer, errors: string[]): void {
  if (entry.command !== undefined || entry.url !== undefined) {
    map.set(entry.name, { ...entry });
    return;
  }
  const existing = map.get(entry.name);
  if (!existing) {
    errors.push(`项目配置只写了 exposure，但没有名为 ${entry.name} 的服务器`);
    return;
  }
  const next: McpMergeServer = { ...existing };
  if (entry.enabled !== undefined) next.enabled = entry.enabled;
  if (entry.exposure !== undefined) next.exposure = entry.exposure;
  if (entry.toolExposure !== undefined) next.toolExposure = entry.toolExposure;
  if (entry.description !== undefined) next.description = entry.description;
  map.set(entry.name, next);
}

function normalizeListedExposure(value: string | undefined): McpExposure | undefined {
  if (value === undefined) return undefined;
  return normalizeExposure(value);
}

function exposurePatternMatches(pattern: string, toolName: string): boolean {
  const body = pattern.split("*").map(escapeRegExp).join("[^/]*");
  return new RegExp(`^${body}$`).test(toolName);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function expandConfigString(value: string, env: ExpandConfigContext): string {
  const command = /^!(.+)$/.exec(value);
  if (command) {
    return execSync(command[1], { encoding: "utf8", windowsHide: true }).trim();
  }
  return value.replace(/\$\{([^}]+)\}/g, (match, name: string) => {
    const found = env[name];
    return found === undefined ? match : found;
  });
}

function expandCwd(cwd: string, home: string, sessionCwd: string): string {
  let value = cwd;
  if (value === "~") value = home;
  else if (value.startsWith("~/") || value.startsWith("~\\")) {
    const separator = value[1];
    value = `${home.replace(/[\\/]+$/, "")}${separator}${value.slice(2)}`;
  }
  if (value.startsWith("/") || value.startsWith("\\") || isAbsolute(value)) return value;
  return sessionCwd ? resolve(sessionCwd, value) : value;
}

function mapValues(record: Record<string, string>, expand: (value: string) => string): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, expand(value)]));
}
