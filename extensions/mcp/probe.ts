// 一次性探测：连接单个 MCP server、listTools、回传/缓存工具名。复用 mcp 扩展同款 SDK + 名称规则。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sanitize, type McpServerConfig } from "./config.js";
import { writeToolsCacheEntry } from "./toolsCache.js";

export interface ProbeResult {
  ok: boolean;
  toolNames: string[];
  error?: string;
}

const PROBE_TIMEOUT_MS = Number(process.env.MCP_PROBE_TIMEOUT_MS ?? "30000") || 30000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

export async function probeServer(s: McpServerConfig, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  const client = new Client({ name: "grenagent-probe", version: "0.1.0" });
  const transport =
    s.transport === "sse"
      ? new SSEClientTransport(new URL(s.url ?? ""))
      : new StdioClientTransport({
          command: s.command ?? "",
          args: s.args ?? [],
          ...(s.cwd ? { cwd: s.cwd } : {}),
          env: { ...(process.env as Record<string, string>), ...(s.env ?? {}) },
        });
  try {
    await withTimeout(client.connect(transport), timeoutMs);
    const { tools } = await withTimeout(client.listTools(), timeoutMs);
    const toolNames = tools.map((t) => `mcp__${sanitize(s.name)}__${sanitize(t.name)}`);
    return { ok: true, toolNames };
  } catch (e) {
    return { ok: false, toolNames: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    await client.close().catch(() => {});
  }
}

// `pi probe-mcp` 子命令入口：读 MCP_PROBE_CONFIG（或 argv[3]）里的单个 server 配置，
// 探测、写缓存、把 ProbeResult 打到 stdout（仅这一行）。诊断信息一律走 stderr。
export async function runProbeCli(): Promise<void> {
  const raw = process.env.MCP_PROBE_CONFIG ?? process.argv[3] ?? "";
  let cfg: McpServerConfig | undefined;
  try {
    cfg = JSON.parse(raw) as McpServerConfig;
  } catch {
    process.stdout.write(`${JSON.stringify({ ok: false, toolNames: [], error: "invalid MCP_PROBE_CONFIG" })}\n`);
    return;
  }
  const result = await probeServer(cfg);
  try {
    writeToolsCacheEntry(cfg.name, result);
  } catch (e) {
    console.error(`[mcp-probe] cache write failed: ${e instanceof Error ? e.message : e}`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
