// mcp: 把外部 MCP server（stdio/SSE）的工具暴露给 agent，名为 mcp__<server>__<tool>。
// 连接/热更新在进程级管理器（manager.ts），跨会话存活；本文件只做每会话薄绑定：
// session_start 用新鲜 pi 登记+激活当前目录并订阅变化，session_shutdown 解绑。
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sanitize } from "./config.js";
import { getMcpManager, type McpAuthKind, type McpManager, type McpSnapshot } from "./manager.js";
import { exposureForTool, normalizeExposure, type McpExposure } from "./merge.js";
import { registerToolName } from "./naming.js";
import { shapeMcpResult } from "./resultShape.js";
import { authorizeDesktopOperation, desktopControl, type DesktopControlPort } from "../_shared/desktop-control.js";
import { currentCwd } from "../_shared/workspace-context.js";
import { waitForDirect } from "./wait.js";

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

// 每 server 的 status / 工具数 / 注册全名，加上 exposure 与 auth（权限面板依赖）。
export function summary(snap: McpSnapshot): ServerSummary[] {
  return [...snap.servers.entries()].map(([name, e]) => ({
    name,
    status: e.status,
    tools: e.tools.length,
    toolNames: e.tools.map((t) => `mcp__${sanitize(name)}__${sanitize(t.name)}`),
    exposure: normalizeExposure(e.exposure) ?? "codemode",
    auth: summaryAuth(e.auth),
  }));
}

interface ProjectablePi {
  registerTool: ExtensionAPI["registerTool"];
  getActiveTools: ExtensionAPI["getActiveTools"];
  setActiveTools: ExtensionAPI["setActiveTools"];
}

// 把当前目录投射进会话：按 exposure 登记已连工具。direct 进入激活集；
// codemode / deferred / hidden 不进入。激活集里非 direct 的 mcp__ 一律去掉。
export function project(pi: ProjectablePi, snap: McpSnapshot, mgr: Pick<McpManager, "callTool">, control?: DesktopControlPort): void {
  const direct: string[] = [];
  let hasCodemodeServer = false;
  let hasDeferred = false;
  const taken = new Set<string>();

  for (const [server, entry] of snap.servers) {
    if (entry.status !== "connected") continue;
    const serverExposure = normalizeExposure(entry.exposure) ?? "codemode";
    if (serverExposure === "codemode") hasCodemodeServer = true;
    if (serverExposure === "deferred") hasDeferred = true;
    const namespace = {
      name: `mcp__${server.replace(/-/g, "_")}`,
      description: entry.description,
    };
    for (const t of entry.tools) {
      const { name, originalToolName } = registerToolName(server, t.name, taken);
      taken.add(name);
      const exposure = exposureForTool(t.name, { exposure: entry.exposure, toolExposure: entry.toolExposure });
      if (exposure === "codemode") hasCodemodeServer = true;
      if (exposure === "deferred") hasDeferred = true;
      if (exposure === "direct") direct.push(name);
      pi.registerTool({
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
              workspace: typeof ctx?.cwd === 'string' ? ctx.cwd : currentCwd(),
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
      } as Parameters<ProjectablePi["registerTool"]>[0]);
    }
  }
  try {
    const active = pi.getActiveTools();
    const next = active.filter((n) => !n.startsWith("mcp__") || direct.includes(n));
    for (const n of direct) if (!next.includes(n)) next.push(n);
    if (hasCodemodeServer && snap.autoEnableCodemode !== false && !next.includes("codemode")) next.push("codemode");
    if (hasDeferred && !next.includes("tool_search")) next.push("tool_search");
    pi.setActiveTools(next);
  } catch {
    // active-tool plumbing 尚未就绪：工具已登记，稍后可被激活
  }
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

export function bind(pi: ExtensionAPI, mgr: McpManager, control: DesktopControlPort = desktopControl()): void {
  let alive = false;
  let unsub: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    mgr.init();
    alive = true;
    const render = (snap: McpSnapshot): void => {
      if (!alive) return;
      project(pi, snap, mgr, control);
      void control.request('mcp.state.publish', {
        workspace: typeof ctx.cwd === 'string' ? ctx.cwd : currentCwd(),
        servers: summary(snap),
      }).catch(() => {});
    };
    render(mgr.snapshot());
    unsub = mgr.subscribe(render);
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
}

export default function (pi: ExtensionAPI) {
  bind(pi, getMcpManager());
}
