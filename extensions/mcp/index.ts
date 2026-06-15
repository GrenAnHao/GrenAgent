// mcp: 把外部 MCP server（stdio/SSE）的工具暴露给 agent，名为 mcp__<server>__<tool>。
// 连接/热更新在进程级管理器（manager.ts），跨会话存活；本文件只做每会话薄绑定：
// session_start 用新鲜 pi 登记+激活当前目录并订阅变化，session_shutdown 解绑。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sanitize } from "./config.js";
import { getMcpManager, type McpManager, type McpSnapshot } from "./manager.js";

export interface ServerSummary {
  name: string;
  status: string;
  tools: number;
  toolNames: string[];
}

// 与旧 summary() 形状一致：每 server 的 status / 工具数 / 注册全名（权限面板依赖）。
export function summary(snap: McpSnapshot): ServerSummary[] {
  return [...snap.servers.entries()].map(([name, e]) => ({
    name,
    status: e.status,
    tools: e.tools.length,
    toolNames: e.tools.map((t) => `mcp__${sanitize(name)}__${sanitize(t.name)}`),
  }));
}

interface ProjectablePi {
  registerTool: ExtensionAPI["registerTool"];
  getActiveTools: ExtensionAPI["getActiveTools"];
  setActiveTools: ExtensionAPI["setActiveTools"];
}

// 把当前目录投射进会话：登记已连工具，激活它们，停用已不在连接中的 mcp__ 工具。
export function project(pi: ProjectablePi, snap: McpSnapshot, mgr: Pick<McpManager, "callTool">): void {
  const connected: string[] = [];
  for (const [server, entry] of snap.servers) {
    if (entry.status !== "connected") continue;
    for (const t of entry.tools) {
      const full = `mcp__${sanitize(server)}__${sanitize(t.name)}`;
      connected.push(full);
      pi.registerTool({
        name: full,
        label: `${server}: ${t.name}`,
        description: t.description ?? `MCP tool "${t.name}" from server "${server}".`,
        parameters: Type.Unsafe(t.inputSchema ?? { type: "object" }),
        async execute(_toolCallId, params) {
          const r = await mgr.callTool(server, t.name, (params ?? {}) as Record<string, unknown>);
          return { content: [{ type: "text", text: r.text }], details: { server, tool: t.name } };
        },
      });
    }
  }
  try {
    const connectedSet = new Set(connected);
    const active = pi.getActiveTools();
    const next = active.filter((n) => !n.startsWith("mcp__") || connectedSet.has(n));
    for (const n of connected) if (!next.includes(n)) next.push(n);
    pi.setActiveTools(next);
  } catch {
    // active-tool plumbing 尚未就绪：工具已登记，稍后可被激活
  }
}

export function bind(pi: ExtensionAPI, mgr: McpManager): void {
  let alive = false;
  let unsub: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    mgr.init();
    alive = true;
    const render = (snap: McpSnapshot): void => {
      if (!alive) return;
      project(pi, snap, mgr);
      if (ctx.hasUI) {
        try {
          ctx.ui.setStatus("mcp", JSON.stringify(summary(snap)));
        } catch {
          // 状态推送 best-effort
        }
      }
    };
    render(mgr.snapshot());
    unsub = mgr.subscribe(render);
  });

  pi.on("session_shutdown", () => {
    alive = false;
    unsub?.();
    unsub = undefined;
  });
}

export default function (pi: ExtensionAPI) {
  bind(pi, getMcpManager());
}
