// Pure helpers for the mcp extension: parse the MCP_SERVERS JSON config and
// sanitize names for tool registration. No I/O so the logic stays testable.
import { homedir } from "node:os";
import { expandConfigValues } from "./merge.js";

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** stdio server 工作目录（透传给 StdioClientTransport）。 */
  cwd?: string;
  exposure?: string;
  toolExposure?: Record<string, string>;
  description?: string;
  enabled?: boolean;
  timeout?: number;
  oauth?: unknown;
  auth?: unknown;
}

/** 没有 command/url 的项目条目，只覆盖已有服务器的这几项。 */
export interface McpServerOverride {
  name: string;
  exposure?: string;
  toolExposure?: Record<string, string>;
  description?: string;
  enabled?: boolean;
}

export type McpLayerEntry = McpServerConfig | McpServerOverride;

/** `/sse` 走旧 SSE 传输，其余 remote URL 走 Streamable HTTP。 */
export function remoteTransportKind(url: string): "sse" | "http" {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "").toLowerCase();
    if (path === "/sse" || path.endsWith("/sse")) return "sse";
  } catch {
    // 非法 URL 仍按 streamable HTTP 交给连接层报错。
  }
  return "http";
}


function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function asStrArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function asStrRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(asRecord(v))) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

// Parse a `{ name: { command/args/env } | { url } }` map. `url` ⇒ SSE, `command` ⇒ stdio.
// Tolerates empty / invalid JSON and entries missing both command and url.
export function parseMcpServers(json: string): McpServerConfig[] {
  return collectMcpEntries(json, false).filter((entry): entry is McpServerConfig => "transport" in entry);
}

/** 与 parseMcpServers 相同，另外保留只写 exposure / enabled 等覆盖字段的条目。 */
export function parseMcpLayerEntries(json: string): McpLayerEntry[] {
  return collectMcpEntries(json, true);
}

function collectMcpEntries(json: string, includeOverrides: boolean): McpLayerEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const root = asRecord(parsed);
  // Standard format `{ "mcpServers": { name: {...} } }` (like .cursor/mcp.json /
  // Claude Desktop); also accept a bare `{ name: {...} }` map for convenience.
  const source = "mcpServers" in root ? asRecord(root.mcpServers) : root;
  const servers: McpLayerEntry[] = [];
  for (const [name, raw] of Object.entries(source)) {
    const entry = serverFromRaw(name, raw, includeOverrides);
    if (entry) servers.push(entry);
  }
  return servers;
}

function serverFromRaw(name: string, raw: unknown, includeOverrides: boolean): McpLayerEntry | undefined {
  const cfg = asRecord(raw);
  const extras = optionalServerFields(cfg);
  const url = typeof cfg.url === "string" ? cfg.url : undefined;
  const command = typeof cfg.command === "string" ? cfg.command : undefined;
  if (url) {
    const headers = asStrRecord(cfg.headers);
    return {
      name,
      transport: remoteTransportKind(url),
      url,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...extras,
    };
  }
  if (command) {
    const cwd = typeof cfg.cwd === "string" ? cfg.cwd : undefined;
    return {
      name,
      transport: "stdio",
      command,
      args: asStrArray(cfg.args),
      env: asStrRecord(cfg.env),
      ...(cwd ? { cwd } : {}),
      ...extras,
    };
  }
  if (!includeOverrides || !hasServerOverride(cfg)) return undefined;
  return { name, ...overrideFields(cfg) };
}

function optionalServerFields(cfg: Record<string, unknown>): Partial<McpServerConfig> {
  return {
    ...overrideFields(cfg),
    ...(typeof cfg.timeout === "number" && Number.isFinite(cfg.timeout) ? { timeout: cfg.timeout } : {}),
    ...("oauth" in cfg && cfg.oauth !== undefined ? { oauth: cfg.oauth } : {}),
    ...("auth" in cfg && cfg.auth !== undefined ? { auth: cfg.auth } : {}),
  };
}

function overrideFields(cfg: Record<string, unknown>): Partial<McpServerOverride> {
  const out: Partial<McpServerOverride> = {};
  if (typeof cfg.exposure === "string") out.exposure = cfg.exposure;
  if (isPlainRecord(cfg.toolExposure)) out.toolExposure = asStrRecord(cfg.toolExposure);
  if (typeof cfg.description === "string") out.description = cfg.description;
  if (typeof cfg.enabled === "boolean") out.enabled = cfg.enabled;
  return out;
}

function hasServerOverride(cfg: Record<string, unknown>): boolean {
  return typeof cfg.exposure === "string"
    || isPlainRecord(cfg.toolExposure)
    || typeof cfg.description === "string"
    || typeof cfg.enabled === "boolean";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// 默认内置服务注入：
// 1) open-webSearch（多引擎搜索 bing/baidu/sogou/csdn/掘金 + 文章抓取，零配置）：OPEN_WEBSEARCH=0 关闭，
//    用户自定义同名 server 时以用户配置为准。Windows 经 `cmd /c npx`，其余平台直接用 npx。
export function injectDefaultServers(
  servers: McpServerConfig[],
  env: Record<string, string | undefined>,
  platform: string,
  _userServerTools: Record<string, string[]> = {},
  _architecture = process.arch,
): McpServerConfig[] {
  let out = servers.filter((server) => server.name !== "codebase-memory");

  // open-websearch。
  if ((env.OPEN_WEBSEARCH ?? "0") !== "0" && !out.some((s) => s.name === "open-websearch")) {
    const isWin = platform === "win32";
    out = [
      ...out,
      {
        name: "open-websearch",
        transport: "stdio",
        command: isWin ? "cmd" : "npx",
        args: isWin ? ["/c", "npx", "-y", "open-websearch@latest"] : ["-y", "open-websearch@latest"],
        env: {
          MODE: "stdio",
          DEFAULT_SEARCH_ENGINE: env.OPEN_WEBSEARCH_ENGINE ?? "bing",
          ALLOWED_SEARCH_ENGINES: env.OPEN_WEBSEARCH_ENGINES ?? "bing,baidu,sogou,csdn,juejin",
        },
      },
    ];
  }

  return out;
}

export function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_");
}

// Expand ${workspaceFolder} / ${cwd} / ${ENV}, a whole-value !command, and cwd ~/
// or relative paths. Applied for BOTH main and sub agents (see manager.defaultReadServers).
export function expandServerVars(servers: McpServerConfig[], cwd: string): McpServerConfig[] {
  const context = {
    ...process.env,
    workspaceFolder: cwd,
    cwd,
    home: homedir(),
    sessionCwd: cwd,
  };
  return servers.map((server) => expandConfigValues(server, context));
}
