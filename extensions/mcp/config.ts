// Pure helpers for the mcp extension: parse the MCP_SERVERS JSON config and
// sanitize names for tool registration. No I/O so the logic stays testable.

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  /** stdio server 工作目录（透传给 StdioClientTransport）。 */
  cwd?: string;
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
  const servers: McpServerConfig[] = [];
  for (const [name, raw] of Object.entries(source)) {
    const cfg = asRecord(raw);
    const url = typeof cfg.url === "string" ? cfg.url : undefined;
    const command = typeof cfg.command === "string" ? cfg.command : undefined;
    if (url) {
      servers.push({ name, transport: "sse", url });
    } else if (command) {
      const cwd = typeof cfg.cwd === "string" ? cfg.cwd : undefined;
      servers.push({
        name,
        transport: "stdio",
        command,
        args: asStrArray(cfg.args),
        env: asStrRecord(cfg.env),
        ...(cwd ? { cwd } : {}),
      });
    }
  }
  return servers;
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

// Expand VSCode-style ${workspaceFolder} / ${cwd} placeholders in a server's
// command/args/url/env against the agent's cwd. pi has no built-in expansion, so
// without this a config like `some-server --root ${workspaceFolder}` receives the
// literal string and the server fails to start. Applied for BOTH main and sub
// agents (see manager.defaultReadServers).
export function expandServerVars(servers: McpServerConfig[], cwd: string): McpServerConfig[] {
  const sub = (s: string): string => s.replace(/\$\{workspaceFolder\}/g, cwd).replace(/\$\{cwd\}/g, cwd);
  return servers.map((srv) => ({
    ...srv,
    command: srv.command ? sub(srv.command) : srv.command,
    args: srv.args ? srv.args.map(sub) : srv.args,
    url: srv.url ? sub(srv.url) : srv.url,
    cwd: srv.cwd ? sub(srv.cwd) : srv.cwd,
    env: srv.env ? Object.fromEntries(Object.entries(srv.env).map(([k, v]) => [k, sub(v)])) : srv.env,
  }));
}
