import { catalogTools, type CatalogTool } from "./catalog.js";
import type { McpManager, McpSnapshot } from "./manager.js";
import { summary, type ServerSummary } from "./summary.js";
import type { ConnectionDiagnostics } from "./diagnostics.js";

export interface McpInspection {
  servers: ServerSummary[];
  catalog?: CatalogTool[];
  diagnostics?: ConnectionDiagnostics;
}

function selectedTools(snap: McpSnapshot, server: string): CatalogTool[] {
  const taken = new Set<string>();
  for (const [name, entry] of snap.servers) {
    if (entry.status !== "connected") continue;
    const catalog = catalogTools(name, entry.tools, taken);
    if (name === server) return catalog;
  }
  return [];
}

/** No init, probes or reconnections: opening settings must not start a server. */
export function inspectMcp(manager: McpManager | undefined, server: string, since?: string): McpInspection {
  if (!manager) return { servers: [] };
  const snap = manager.snapshot();
  const entry = snap.servers.get(server);
  return {
    servers: summary(snap),
    ...(entry?.diagnostics && { diagnostics: entry.diagnostics }),
    ...(entry?.status === "connected" && (!since || since !== entry.diagnostics?.attemptedAt) && { catalog: selectedTools(snap, server) }),
  };
}

export async function callInspectedTool(manager: McpManager | undefined, server: string, fullName: string, args: Record<string, unknown>) {
  if (!manager) throw new Error('服务器未连接');
  const tool = selectedTools(manager.snapshot(), server).find(t => t.fullName === fullName);
  if (!tool) throw new Error("服务器未连接或工具已不在当前目录");
  return manager.callTool(server, tool.name, args);
}
