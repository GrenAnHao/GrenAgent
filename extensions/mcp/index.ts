// mcp: connect external MCP servers (stdio / SSE) and expose their tools to the
// agent as `mcp__<server>__<tool>`.
//
// Servers HOT-RELOAD at runtime: a fs.watch on the runtime config (via
// _shared/runtime-config) re-diffs MCP_SERVERS on change and connects new /
// disconnects removed / re-connects changed servers — no sidecar restart.
// Tools are registered dynamically (pi.registerTool refreshes the registry) and
// activated via setActiveTools; removal deactivates them + closes the client.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Type } from "typebox";
import { getAllConfig, getConfig, watchConfig } from "../_shared/runtime-config.js";
import { injectDefaultServers, type McpServerConfig, parseMcpServers, sanitize } from "./config.js";
import { diffServers } from "./diff.js";

const MCP_TIMEOUT_MS = Number(process.env.MCP_TIMEOUT_MS ?? "60000") || 60000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

async function connect(s: McpServerConfig): Promise<Client> {
  const client = new Client({ name: "grenagent", version: "0.1.0" });
  const transport =
    s.transport === "sse"
      ? new SSEClientTransport(new URL(s.url ?? ""))
      : new StdioClientTransport({
          command: s.command ?? "",
          args: s.args ?? [],
          env: { ...(process.env as Record<string, string>), ...(s.env ?? {}) },
        });
  try {
    await withTimeout(client.connect(transport), MCP_TIMEOUT_MS);
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }
  return client;
}

type McpStatus = "connecting" | "connected" | "failed";

export default function (pi: ExtensionAPI) {
  const readServers = (): McpServerConfig[] =>
    injectDefaultServers(parseMcpServers(getConfig("MCP_SERVERS") ?? ""), getAllConfig(), process.platform);

  let currentServers = readServers();
  const clients = new Map<string, Client>();
  const registry = new Map<string, { status: McpStatus; tools: number; error?: string; toolNames?: string[] }>();
  for (const s of currentServers) registry.set(s.name, { status: "connecting", tools: 0 });

  let pushStatus: (() => void) | undefined;
  const summary = () =>
    [...registry.entries()].map(([name, r]) => ({
      name,
      status: r.status,
      tools: r.tools,
      toolNames: r.toolNames ?? [],
    }));

  const connectServer = async (s: McpServerConfig): Promise<void> => {
    try {
      const client = await connect(s);
      clients.set(s.name, client);
      const { tools } = await withTimeout(client.listTools(), MCP_TIMEOUT_MS);
      const newNames: string[] = [];
      for (const t of tools) {
        const name = `mcp__${sanitize(s.name)}__${sanitize(t.name)}`;
        pi.registerTool({
          name,
          label: `${s.name}: ${t.name}`,
          description: t.description ?? `MCP tool "${t.name}" from server "${s.name}".`,
          parameters: Type.Unsafe(t.inputSchema ?? { type: "object" }),
          async execute(_toolCallId, params) {
            const r = await client.callTool({
              name: t.name,
              arguments: (params ?? {}) as Record<string, unknown>,
            });
            const blocks = Array.isArray(r.content) ? r.content : [];
            const text =
              blocks
                .filter((b): b is { type: "text"; text: string } => !!b && (b as { type?: string }).type === "text")
                .map((b) => b.text)
                .join("\n") || "(no output)";
            return { content: [{ type: "text", text }], details: { server: s.name, tool: t.name } };
          },
        });
        newNames.push(name);
      }
      if (newNames.length) {
        try {
          const active = pi.getActiveTools();
          pi.setActiveTools([...new Set([...active, ...newNames])]);
        } catch {
          // Active-tool plumbing not ready yet; tools stay registered and become callable later.
        }
      }
      registry.set(s.name, { status: "connected", tools: tools.length, toolNames: newNames });
      console.error(`[mcp] connected "${s.name}" (${s.transport}); ${tools.length} tools registered`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      registry.set(s.name, { status: "failed", tools: 0, error: msg });
      console.error(`[mcp] failed to connect "${s.name}": ${msg}`);
    }
    pushStatus?.();
  };

  const disconnectServer = async (name: string): Promise<void> => {
    const client = clients.get(name);
    const toolNames = registry.get(name)?.toolNames ?? [];
    if (client) await client.close().catch(() => {});
    clients.delete(name);
    if (toolNames.length) {
      try {
        const active = pi.getActiveTools();
        pi.setActiveTools(active.filter((t) => !toolNames.includes(t)));
      } catch {
        // ignore: deactivation best-effort
      }
    }
    registry.delete(name);
    console.error(`[mcp] disconnected "${name}"`);
    pushStatus?.();
  };

  let started = false;
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      pushStatus = () => {
        try {
          ctx.ui.setStatus("mcp", JSON.stringify(summary()));
        } catch {
          // Stale ctx after session replacement; the next session_start rebinds pushStatus.
        }
      };
      pushStatus();
    }
    if (started) return;
    started = true;
    void Promise.all(currentServers.map(connectServer));

    // 运行时热更新：MCP_SERVERS 变化 → 先断（移除+变更），再连（新增+变更）。
    watchConfig(() => {
      void (async () => {
        const desired = readServers();
        const { added, removed, changed } = diffServers(currentServers, desired);
        if (!added.length && !removed.length && !changed.length) return;
        currentServers = desired;
        await Promise.all([...removed, ...changed.map((c) => c.name)].map((n) => disconnectServer(n)));
        await Promise.all(
          [...added, ...changed].map((s) => {
            registry.set(s.name, { status: "connecting", tools: 0 });
            return connectServer(s);
          }),
        );
        pushStatus?.();
      })();
    });
  });

  const cleanup = () => {
    for (const c of clients.values()) void c.close().catch(() => {});
  };
  process.on("exit", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
}
