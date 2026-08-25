// Pure helpers for the mcp extension: parse the MCP_SERVERS JSON config and
// sanitize names for tool registration. No I/O so the logic stays testable.
import { join } from "node:path";

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

export interface DefaultServerSecrets {
  knowledgeApiToken?: string;
  knowledgeUserKey?: string;
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
// 2) TencentDB MemoryKnowledge。旧 codebase-memory 即使残留在用户配置中也会被过滤。
export function injectDefaultServers(
  servers: McpServerConfig[],
  env: Record<string, string | undefined>,
  platform: string,
  _userServerTools: Record<string, string[]> = {},
  architecture = process.arch,
  secrets: DefaultServerSecrets = {},
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

  // TencentDB MemoryKnowledge（打包的 stdio MCP）。仅在 Tauri sidecar 注入
  // TDAI_KNOWLEDGE_MCP=1 且能解析打包目录时启用；用户自配同名服务优先。
  if ((env.TDAI_KNOWLEDGE_MCP ?? "0") === "1" && !out.some((s) => s.name === "tencentdb-knowledge")) {
    const pkgDir = env.PI_PACKAGE_DIR ?? "";
    const knowledgeEndpoint = env.TDAI_KNOWLEDGE_ENDPOINT ?? "";
    if (pkgDir && knowledgeEndpoint) {
      const platformDir = knowledgePlatformDir(platform, architecture);
      const root = join(pkgDir, "tencentdb-memory", platformDir);
      const node = platform === "win32" ? join(root, "node", "node.exe") : join(root, "node", "bin", "node");
      const entry = join(root, "knowledge", "bin", "mcp.mjs");
      out = [
        ...out,
        {
          name: "tencentdb-knowledge",
          transport: "stdio",
          command: node,
          args: [entry],
          env: {
            KNOWLEDGE_API_URL: knowledgeEndpoint.replace(/\/v3\/?$/, ""),
            ...(secrets.knowledgeApiToken ? { KNOWLEDGE_API_TOKEN: secrets.knowledgeApiToken } : {}),
            ...(secrets.knowledgeUserKey ? { KNOWLEDGE_USER_KEY: secrets.knowledgeUserKey } : {}),
            ...(env.TDAI_KNOWLEDGE_SERVICE_ID || env.TDAI_MEMORY_SERVICE_ID
              ? { KNOWLEDGE_SERVICE_ID: env.TDAI_KNOWLEDGE_SERVICE_ID ?? env.TDAI_MEMORY_SERVICE_ID! }
              : {}),
            ...(env.TDAI_CODE_GRAPH_ID ? { TDAI_CODE_GRAPH_ID: env.TDAI_CODE_GRAPH_ID } : {}),
            ...(env.TDAI_WIKI_ID ? { TDAI_WIKI_ID: env.TDAI_WIKI_ID } : {}),
          },
        },
      ];
    }
  }

  return out;
}

function knowledgePlatformDir(platform: string, architecture: string): string {
  const arch = architecture === "arm64" || architecture === "aarch64" ? "aarch64" : "x86_64";
  if (platform === "win32") return `windows-${arch}`;
  if (platform === "darwin") return `darwin-${arch}`;
  return `linux-${arch}`;
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
