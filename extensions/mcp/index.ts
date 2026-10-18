// mcp: 把外部 MCP server（stdio/SSE）的工具暴露给 agent，名为 mcp__<server>__<tool>。
// 连接/热更新在进程级管理器（manager.ts），跨会话存活；本文件只做每会话薄绑定：
// session_start 用新鲜 pi 登记+激活当前目录并订阅变化，session_shutdown 解绑。
import { projectCwd } from "../_shared/session-cwd.js";
import type { AgentToolResult, ExtensionAPI, RegisteredMcpServer } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toolPrompt } from "../_shared/toolPrompt.js";
import { remoteTransportKind, sanitize, type McpServerConfig } from "./config.js";
import { getMcpManager, type McpAuthKind, type McpManager, type McpSnapshot } from "./manager.js";
import { exposureForTool, normalizeExposure, type McpExposure } from "./merge.js";
import { registerToolName } from "./naming.js";
import { shapeMcpResult } from "./resultShape.js";
import { authorizeDesktopOperation, desktopControl, type DesktopControlPort } from "../_shared/desktop-control.js";
import { currentCwd } from "../_shared/workspace-context.js";
import { batchToolRefresh } from "../_shared/tool-refresh-batch.js";
import { waitForDirect } from "./wait.js";
import { serversToWait, type ToolReach } from "./reach.js";

/** How long a call that reaches a still-connecting server waits before running without it. */
const REACH_WAIT_MS = 30_000;

type ReachingTool = { name: string; reachesTools?: (input: Record<string, unknown>) => ToolReach };

function reachOf(pi: ExtensionAPI, toolName: string, input: unknown): ToolReach | undefined {
  const read = (pi as { getAllTools?: () => ReachingTool[] }).getAllTools;
  if (typeof read !== "function") return undefined;
  const tool = read().find((candidate) => candidate.name === toolName);
  if (typeof tool?.reachesTools !== "function") return undefined;
  try {
    return tool.reachesTools((input ?? {}) as Record<string, unknown>);
  } catch {
    return "all";
  }
}

export const pluginManifest = {
  id: "mcp",
  version: "0.1.0",
  apiVersion: "1",
  capabilities: ["mcp", "tool", "event-subscriber"],
  permissions: { network: "full", process: "allowlist", secrets: "selected" },
} as const;

export interface ServerSummary {
  name: string;
  status: string;
  tools: number;
  toolNames: string[];
  exposure: McpExposure;
  auth: McpAuthKind;
  loginUrl?: string;
}
type McpToolDetails = { server: string; tool: string; error?: 'denied' | 'blocked' };

const mcpResultOutputSchema = {
  type: "object",
  properties: {
    content: { type: "array", items: { type: "object" } },
    isError: { type: "boolean" },
    structuredContent: {},
  },
  required: ["content"],
};

function summaryAuth(auth: string | undefined): McpAuthKind {
  return auth === "oauth" || auth === "provider" ? auth : "none";
}

// 每 server 的 status / 工具数 / 注册全名，加上 exposure、auth，以及需要登录时的 loginUrl。
export function summary(snap: McpSnapshot): ServerSummary[] {
  return [...snap.servers.entries()].map(([name, e]) => ({
    name,
    status: e.status,
    tools: e.tools.length,
    toolNames: e.tools.map((t) => `mcp__${sanitize(name)}__${sanitize(t.name)}`),
    exposure: normalizeExposure(e.exposure) ?? "codemode",
    auth: summaryAuth(e.auth),
    ...(e.loginUrl ? { loginUrl: e.loginUrl } : {}),
  }));
}

interface ProjectablePi {
  registerTool: ExtensionAPI["registerTool"];
  getActiveTools: ExtensionAPI["getActiveTools"];
  setActiveTools: ExtensionAPI["setActiveTools"];
}

const RESOURCE_TOOL_NAMES = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"] as const;
type ResourceToolName = (typeof RESOURCE_TOOL_NAMES)[number];

const LIST_RESOURCE_PARAMETERS = {
  type: "object",
  properties: {
    server: { type: "string", description: "MCP server name. Omit to list every server with resources." },
    cursor: { type: "string", description: "Opaque cursor from a previous call with the same server." },
  },
  additionalProperties: false,
};

const READ_RESOURCE_PARAMETERS = {
  type: "object",
  properties: {
    server: { type: "string", description: "MCP server name exactly as configured." },
    uri: { type: "string", description: "Resource URI to read." },
  },
  required: ["server", "uri"],
  additionalProperties: false,
};

const RESOURCE_COPY: Record<ResourceToolName, { description: string; snippet: string; guideline: string }> = {
  list_mcp_resources: {
    description: "Lists resources provided by connected MCP servers. Pass server to limit the list to one server.",
    snippet: "List resources from connected MCP servers.",
    guideline: "Use list_mcp_resources to list MCP resources; pass server when only one server should be listed.",
  },
  list_mcp_resource_templates: {
    description: "Lists resource templates provided by connected MCP servers. Pass server to limit the list to one server.",
    snippet: "List resource templates from connected MCP servers.",
    guideline: "Use list_mcp_resource_templates to list MCP resource templates; pass server when only one server should be listed.",
  },
  read_mcp_resource: {
    description: "Reads one MCP resource by server name and URI.",
    snippet: "Read one MCP resource by server name and URI.",
    guideline: "Use read_mcp_resource with the server name and resource URI returned by list_mcp_resources.",
  },
};

type ResourceManager = Pick<McpManager, "callTool"> & Partial<Pick<McpManager, "listResources" | "listResourceTemplates" | "readResource">>;

function widestResourceExposure(snap: McpSnapshot): McpExposure | undefined {
  const exposures: McpExposure[] = [];
  for (const entry of snap.servers.values()) {
    if (entry.status !== "connected" || entry.hasResources !== true) continue;
    exposures.push(normalizeExposure(entry.exposure) ?? "codemode");
  }
  if (exposures.length === 0 || exposures.every((exposure) => exposure === "hidden")) return undefined;
  if (exposures.includes("direct")) return "direct";
  if (exposures.includes("codemode")) return "codemode";
  if (exposures.includes("deferred")) return "deferred";
  return undefined;
}

async function callResource(mgr: ResourceManager, name: ResourceToolName, args: Record<string, unknown>) {
  if (name === "list_mcp_resources") return mgr.listResources?.(args);
  if (name === "list_mcp_resource_templates") return mgr.listResourceTemplates?.(args);
  return mgr.readResource?.(args);
}

function extensionServerConfig(server: RegisteredMcpServer): McpServerConfig {
  const config = server.config;
  const command = "command" in config ? config.command : undefined;
  const url = "url" in config ? config.url : undefined;
  const transport = command ? "stdio" : url ? remoteTransportKind(url) : "stdio";
  return {
    name: server.name,
    transport,
    source: "extension",
    ...(command ? { command, args: config.args, env: config.env, cwd: "cwd" in config ? config.cwd : undefined } : {}),
    ...(url ? { url, headers: "headers" in config ? config.headers : undefined } : {}),
    ...(config.exposure !== undefined ? { exposure: config.exposure } : {}),
    ...(config.toolExposure ? { toolExposure: config.toolExposure } : {}),
    ...(config.description !== undefined ? { description: config.description } : {}),
    ...(config.enabled !== undefined ? { enabled: config.enabled } : {}),
    ...(typeof config.timeout === "number" ? { timeout: config.timeout } : {}),
    ...("oauth" in config && config.oauth !== undefined ? { oauth: config.oauth } : {}),
    ...("auth" in config && config.auth !== undefined ? { auth: config.auth } : {}),
  };
}

function pushExtensionServers(mgr: McpManager, servers: readonly RegisteredMcpServer[] | undefined): Promise<void> | undefined {
  if (typeof mgr.applyExtensionServers !== "function") return undefined;
  return mgr.applyExtensionServers((servers ?? []).map(extensionServerConfig));
}

function isProjectedMcpName(name: string): boolean {
  return name.startsWith("mcp__") || (RESOURCE_TOOL_NAMES as readonly string[]).includes(name);
}

// 把当前目录投射进会话：按 exposure 登记已连工具。direct 进入激活集；
// codemode / deferred / hidden 不进入。
// 还有未登记、且服务器未失败的 mcp__ 名字时，setActiveTools 只追加。
// 少传任何一个当前激活名，Pi 会清掉其余 pending。未登记的名字不传给 setActiveTools，
// 留在返回值里交给下一次 project。pending 清空后再去掉非 direct 的 mcp__ 和三个资源工具。
/** 把 saved 里还不在 active 的名字补进去。未登记的名字不能靠这次调用留在 Pi 的激活集里。 */
export function retainDeferredNames(savedMcpNames: readonly string[], active: readonly string[]): string[] {
  const next = [...active];
  for (const name of savedMcpNames) {
    if (!next.includes(name)) next.push(name);
  }
  return next;
}

const RESTORE_REASONS = new Set(["startup", "reload", "resume", "fork"]);

function toolNameOf(tool: unknown): string | undefined {
  if (!tool || typeof tool !== "object") return undefined;
  const name = (tool as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function restoredMcpNames(sessionManager: { buildSessionProjection?: () => { messages?: readonly unknown[] } } | undefined): string[] {
  const messages = sessionManager?.buildSessionProjection?.().messages;
  if (!Array.isArray(messages)) return [];
  const names = new Set<string>();
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as { role?: unknown; toolsRemoved?: unknown; toolsAdded?: unknown };
    if (record.role !== "system") continue;
    for (const tool of Array.isArray(record.toolsRemoved) ? record.toolsRemoved : []) {
      const name = toolNameOf(tool);
      if (name) names.delete(name);
    }
    for (const tool of Array.isArray(record.toolsAdded) ? record.toolsAdded : []) {
      const name = toolNameOf(tool);
      if (name?.startsWith("mcp__")) names.add(name);
    }
  }
  return [...names];
}

function registeredNames(pi: ExtensionAPI): Set<string> {
  const read = (pi as { getAllTools?: () => Array<{ name: string }> }).getAllTools;
  if (typeof read !== "function") return new Set();
  return new Set(read().map((tool) => tool.name));
}

// 名字还没 registerTool，并且对得上的服务器里有一台仍在连接，或快照里还没有这台服务器。
// 对得上的服务器都已列出工具或已失败时，这个名字可以离开保存列表。
function outstandingMcpName(name: string, snap: McpSnapshot, registeredNow: ReadonlySet<string>): boolean {
  if (!name.startsWith("mcp__") || registeredNow.has(name)) return false;
  let matched = false;
  for (const [server, entry] of snap.servers) {
    if (!name.startsWith(`mcp__${sanitize(server)}__`)) continue;
    matched = true;
    if (entry.status !== "connected" && entry.status !== "failed") return true;
  }
  return !matched;
}

/**
 * 每个 pi 会话一份：工具名 → 上次 registerTool 时的定义指纹。
 * 每次快照推送都会投影一遍；定义没变的工具不再注册，否则连接中 / 断开 / 重连都要把全部工具重注册一遍。
 */
export type ProjectionCache = Map<string, string>;

interface RegisteredProjection {
  direct: string[];
  hasCodemodeServer: boolean;
  hasDeferred: boolean;
  taken: Set<string>;
}

export function project(
  pi: ProjectablePi,
  snap: McpSnapshot,
  mgr: ResourceManager,
  control?: DesktopControlPort,
  savedMcpNames: readonly string[] = [],
  registered: ProjectionCache = new Map(),
): string[] {
  // pi 每次 registerTool 都全量刷新一次工具表（重渲染全部 codemode 描述）。整批注册合并成一次刷新；
  // 下面算活动工具要用刷新后的工具表，所以必须放在批量结束之后。
  const { direct, hasCodemodeServer, hasDeferred, taken } = batchToolRefresh(
    () => registerProjectedTools(pi, snap, mgr, control, registered),
  );
  const pending = savedMcpNames.filter((name) => outstandingMcpName(name, snap, taken));
  try {
    const active = pi.getActiveTools();
    const preservePending = pending.length > 0;
    const next = preservePending
      ? [...active]
      : active.filter((n) => !isProjectedMcpName(n) || direct.includes(n));
    for (const n of direct) if (!next.includes(n)) next.push(n);
    if (hasCodemodeServer && snap.autoEnableCodemode !== false && !next.includes("codemode")) next.push("codemode");
    if (hasDeferred && !next.includes("tool_search")) next.push("tool_search");
    const finalNames = preservePending ? next : retainDeferredNames(pending, next);
    // 清单没变就不再设：每次 setActiveTools 都会让 codemode 重新渲染全部工具描述。
    if (!sameNames(finalNames, active)) pi.setActiveTools(finalNames);
  } catch {
    // active-tool plumbing 尚未就绪：工具已登记，稍后可被激活
  }
  return pending;
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function registerProjectedTools(
  pi: ProjectablePi,
  snap: McpSnapshot,
  mgr: ResourceManager,
  control: DesktopControlPort | undefined,
  registered: ProjectionCache,
): RegisteredProjection {
  const direct: string[] = [];
  let hasCodemodeServer = false;
  let hasDeferred = false;
  const taken = new Set<string>();
  const registerChanged = (name: string, fingerprint: string, register: () => void): void => {
    if (registered.get(name) === fingerprint) return;
    register();
    registered.set(name, fingerprint);
  };

  for (const [server, entry] of snap.servers) {
    if (entry.status !== "connected") continue;
    const serverExposure = normalizeExposure(entry.exposure) ?? "codemode";
    if (serverExposure === "codemode") hasCodemodeServer = true;
    if (serverExposure === "deferred") hasDeferred = true;
    // aliases (pi 1.2): codemode describeNamespace("antd") and the namespace option of searchTools
    // accept the bare server name, matching pi built-in MCP.
    const namespace = {
      name: `mcp__${server.replace(/-/g, "_")}`,
      description: entry.description,
      aliases: [server],
    };
    for (const t of entry.tools) {
      const { name, originalToolName } = registerToolName(server, t.name, taken);
      taken.add(name);
      const exposure = exposureForTool(t.name, { exposure: entry.exposure, toolExposure: entry.toolExposure });
      if (exposure === "codemode") hasCodemodeServer = true;
      if (exposure === "deferred") hasDeferred = true;
      if (exposure === "direct") direct.push(name);
      const fingerprint = JSON.stringify([server, t.name, t.description ?? null, t.inputSchema ?? null, exposure, namespace.name, namespace.description ?? null, namespace.aliases]);
      registerChanged(name, fingerprint, () => pi.registerTool({
        name,
        originalToolName,
        label: `${server}: ${t.name}`,
        description: t.description ?? `MCP tool "${t.name}" from server "${server}".`,
        promptSnippet: t.description?.trim() || `MCP tool "${t.name}" from server "${server}".`,
        parameters: Type.Unsafe(t.inputSchema ?? { type: "object" }),
        exposure,
        namespace,
        outputSchema: mcpResultOutputSchema,
        async execute(_toolCallId, params, _signal, _update, ctx): Promise<AgentToolResult<McpToolDetails>> {
          if (control) {
            const authorization = await authorizeDesktopOperation(control, {
              kind: 'mcp.call',
              workspace: typeof ctx?.cwd === 'string' ? projectCwd(ctx) : currentCwd(),
              server,
              toolName: originalToolName,
              args: params ?? {},
            });
            if (authorization.status !== 'allowed') {
              return {
                content: [{ type: 'text', text: `MCP 调用已被 Electron 权限策略${authorization.status === 'blocked' ? '暂停' : '拒绝'}` }],
                details: { server, tool: originalToolName, error: authorization.status },
                isError: true,
              };
            }
          }
          const raw = await mgr.callTool(server, originalToolName, (params ?? {}) as Record<string, unknown>);
          const shaped = shapeMcpResult({
            content: Array.isArray(raw.content) ? raw.content as { type: string }[] : undefined,
            isError: raw.isError,
            structuredContent: raw.structuredContent,
          });
          return {
            content: shaped.content as AgentToolResult<McpToolDetails>["content"],
            details: { server, tool: originalToolName },
            isError: shaped.isError,
            structuredContent: shaped.structuredContent as AgentToolResult<McpToolDetails>["structuredContent"],
          };
        },
      } as Parameters<ProjectablePi["registerTool"]>[0]));
    }
  }
  const resourcesExposure = widestResourceExposure(snap);
  if (resourcesExposure) {
    if (resourcesExposure === "codemode") hasCodemodeServer = true;
    if (resourcesExposure === "deferred") hasDeferred = true;
    if (resourcesExposure === "direct") {
      for (const name of RESOURCE_TOOL_NAMES) direct.push(name);
    }
    for (const name of RESOURCE_TOOL_NAMES) {
      const copy = RESOURCE_COPY[name];
      registerChanged(name, JSON.stringify(["resource", resourcesExposure]), () => pi.registerTool({
        name,
        label: name,
        description: copy.description,
        ...toolPrompt(copy.snippet, [copy.guideline]),
        parameters: Type.Unsafe(name === "read_mcp_resource" ? READ_RESOURCE_PARAMETERS : LIST_RESOURCE_PARAMETERS),
        exposure: resourcesExposure,
        outputSchema: mcpResultOutputSchema,
        async execute(_toolCallId, params, _signal, _update, ctx): Promise<AgentToolResult<McpToolDetails>> {
          const args = (params ?? {}) as Record<string, unknown>;
          const server = typeof args.server === "string" ? args.server : "";
          if (control) {
            const authorization = await authorizeDesktopOperation(control, {
              kind: "mcp.call",
              workspace: typeof ctx?.cwd === "string" ? projectCwd(ctx) : currentCwd(),
              server,
              toolName: name,
              args,
            });
            if (authorization.status !== "allowed") {
              return {
                content: [{ type: "text", text: `MCP 调用已被 Electron 权限策略${authorization.status === "blocked" ? "暂停" : "拒绝"}` }],
                details: { server, tool: name, error: authorization.status },
                isError: true,
              };
            }
          }
          const raw = await callResource(mgr, name, args);
          const shaped = shapeMcpResult({
            content: Array.isArray(raw?.content) ? raw.content as { type: string }[] : undefined,
            isError: raw?.isError,
            structuredContent: raw?.structuredContent,
          });
          return {
            content: shaped.content as AgentToolResult<McpToolDetails>["content"],
            details: { server, tool: name },
            isError: shaped.isError,
            structuredContent: shaped.structuredContent as AgentToolResult<McpToolDetails>["structuredContent"],
          };
        },
      } as Parameters<ProjectablePi["registerTool"]>[0]));
    }
  }
  return { direct, hasCodemodeServer, hasDeferred, taken };
}

function serverIncludesDirect(entry: { exposure?: string; toolExposure?: Record<string, string>; tools: { name: string }[] }): boolean {
  if (entry.tools.some((tool) => exposureForTool(tool.name, entry) === "direct")) return true;
  if (entry.tools.length > 0) return false;
  if ((normalizeExposure(entry.exposure) ?? "codemode") === "direct") return true;
  const overrides = entry.toolExposure;
  if (!overrides) return false;
  return Object.values(overrides).some((value) => normalizeExposure(value) === "direct");
}

function oneLineDescription(description: string | undefined): string {
  if (!description) return "";
  return (description.split("\n", 1)[0] ?? "").trim();
}

function formatServerSummary(snap: McpSnapshot): string {
  const lines: string[] = [];
  for (const [name, entry] of snap.servers) {
    const exposure = normalizeExposure(entry.exposure) ?? "codemode";
    const description = oneLineDescription(entry.description);
    lines.push(description ? `${name} ${exposure} ${description}` : `${name} ${exposure}`);
  }
  return lines.join("\n");
}

function entryText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const text = (part as { type?: unknown; text?: unknown }).text;
    return (part as { type?: unknown }).type === "text" && typeof text === "string" ? [text] : [];
  });
  return parts.length > 0 ? parts.join("") : undefined;
}

function lastServerSummary(sessionManager: { buildContextEntries?: () => readonly unknown[]; getEntries?: () => readonly unknown[] } | undefined): string | undefined {
  const entries = sessionManager?.buildContextEntries?.() ?? sessionManager?.getEntries?.() ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as {
      type?: string;
      customType?: string;
      content?: unknown;
      message?: { customType?: string; content?: unknown };
    } | undefined;
    if (entry?.type === "custom_message" && entry.customType === "mcp-servers") return entryText(entry.content);
    if (entry?.message?.customType === "mcp-servers") return entryText(entry.message.content);
  }
  return undefined;
}

/** ModelRuntime.getAuth 暴露的当前供应商登录态。只取 apiKey，和 ModelRegistry.getApiKeyForProvider 一致。 */
interface ProviderTokenRuntime {
  getAuth(providerId: string): Promise<{ auth?: { apiKey?: string } } | undefined>;
}

function providerRuntimeOf(ctx: unknown): ProviderTokenRuntime | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const registry = (ctx as { modelRegistry?: unknown }).modelRegistry;
  if (!registry || typeof registry !== "object") return undefined;
  const runtime = (registry as { runtime?: unknown }).runtime;
  if (!runtime || typeof runtime !== "object") return undefined;
  if (typeof (runtime as { getAuth?: unknown }).getAuth !== "function") return undefined;
  return runtime as ProviderTokenRuntime;
}

async function providerTokenFromRuntime(runtime: ProviderTokenRuntime, provider: string): Promise<string | undefined> {
  try {
    const key = (await runtime.getAuth(provider))?.auth?.apiKey;
    return typeof key === "string" && key.length > 0 ? key : undefined;
  } catch {
    return undefined;
  }
}

export function bind(pi: ExtensionAPI, mgr: McpManager, control: DesktopControlPort = desktopControl()): void {
  let alive = false;
  let unsub: (() => void) | undefined;
  let tokenRuntime: ProviderTokenRuntime | undefined;
  let savedMcpNames: string[] = [];
  // 工具登记在这个 pi 的扩展上，跟着 pi 实例走；每次快照推送只补登记有变化的。
  const registered: ProjectionCache = new Map();

  pi.on("session_start", (event, ctx) => {
    const runtime = providerRuntimeOf(ctx);
    // 进程内共享同一份 ModelRuntime。后来的会话拿到同一对象时不换回调。
    if (runtime && runtime !== tokenRuntime) {
      tokenRuntime = runtime;
      mgr.getProviderToken = (provider) => providerTokenFromRuntime(runtime, provider);
    }
    mgr.init();
    alive = true;
    if (RESTORE_REASONS.has(event.reason)) {
      const registered = registeredNames(pi);
      const names = new Set<string>([
        ...pi.getActiveTools().filter((name) => name.startsWith("mcp__")),
        ...restoredMcpNames(ctx.sessionManager),
      ]);
      savedMcpNames = [...names].filter((name) => !registered.has(name));
    } else {
      savedMcpNames = [];
    }
    const render = (snap: McpSnapshot): void => {
      if (!alive) return;
      savedMcpNames = project(pi, snap, mgr, control, savedMcpNames, registered);
      void control.request('mcp.state.publish', {
        workspace: typeof ctx.cwd === 'string' ? projectCwd(ctx) : currentCwd(),
        servers: summary(snap),
      }).catch(() => {});
    };
    render(mgr.snapshot());
    unsub = mgr.subscribe(render);
    const listed = typeof pi.getMcpServers === "function" ? pi.getMcpServers() : [];
    return pushExtensionServers(mgr, listed);
  });

  pi.on("mcp_servers_change", (event) => {
    if (!alive) return;
    return pushExtensionServers(mgr, event.servers);
  });

  pi.on("session_shutdown", () => {
    alive = false;
    unsub?.();
    unsub = undefined;
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const pendings: Promise<unknown>[] = [];
    for (const [name, entry] of mgr.snapshot().servers) {
      if (!serverIncludesDirect(entry)) continue;
      const pending = mgr.connectPromise(name);
      if (pending) pendings.push(pending);
    }
    await waitForDirect(pendings, 10_000);
    const content = formatServerSummary(mgr.snapshot());
    const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & {
      appendMessage?: (message: { role: "custom"; customType: string; content: string; display: boolean; timestamp: number }) => void;
    };
    const previous = lastServerSummary(sessionManager);
    if (content === (previous ?? "")) return undefined;
    const message = { customType: "mcp-servers", content, display: false as const };
    if (typeof sessionManager.appendMessage === "function") {
      sessionManager.appendMessage({ role: "custom", ...message, timestamp: Date.now() });
    }
    return { message };
  });

  // A call that reaches other tools (codemode, tool_search: pi `reachesTools`) waits for the servers
  // it may reach that are still connecting, so their tools are registered before it runs; a direct
  // MCP call waits for its own server. before_agent_start above only waits for direct servers, which
  // must be in the active set before the request; codemode / deferred servers are waited for here.
  pi.on("tool_call", async (event, ctx) => {
    const connecting = [...mgr.snapshot().servers.keys()].filter((name) => mgr.connectPromise(name) !== undefined);
    if (connecting.length === 0) return undefined;
    const waiting = serversToWait({
      toolName: event.toolName,
      reach: reachOf(pi, event.toolName, event.input),
      connecting,
      resourceTools: RESOURCE_TOOL_NAMES,
    });
    const pendings = waiting.flatMap((name) => {
      const pending = mgr.connectPromise(name);
      return pending ? [pending] : [];
    });
    await waitForDirect(pendings, REACH_WAIT_MS, ctx?.signal);
    return undefined;
  });
}

export default function (pi: ExtensionAPI) {
  bind(pi, getMcpManager());
}
