// 一次性探测：连接单个 MCP server、listTools、回传/缓存工具名。复用 mcp 扩展同款 SDK + 名称规则。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { sanitize, type McpServerConfig } from "./config.js";
import { createMcpTransport } from "./transport.js";
import { writeToolsCacheEntry } from "./toolsCache.js";

export interface ProbeResult {
  ok: boolean;
  toolNames: string[];
  error?: string;
}

const PROBE_TIMEOUT_MS = Number(process.env.MCP_PROBE_TIMEOUT_MS ?? "30000") || 30000;

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`timeout after ${ms}ms`));
    }, ms);
    p.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function readTransportPid(transport: unknown): number | undefined {
  if (!transport || typeof transport !== "object") return undefined;
  const rec = transport as { pid?: unknown; _process?: { pid?: unknown }; process?: { pid?: unknown } };
  const candidates = [rec.pid, rec._process?.pid, rec.process?.pid];
  for (const pid of candidates) {
    if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) return pid;
  }
  return undefined;
}

/** POSIX 进程组语义的完整版是第 4 份的 killTree。未暴露 pid 时无法 killTree。 */
export function killProbeChild(pid: number): void {
  try {
    if (process.platform === "win32") process.kill(pid);
    else process.kill(-pid, "SIGKILL");
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* 已退 */ }
  }
}

export async function probeServer(s: McpServerConfig, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  const client = new Client({ name: "grenagent-probe", version: "0.1.0" });
  const transport = createMcpTransport(s);
  let timedOut = false;
  const markTimeout = () => { timedOut = true; };
  try {
    await withTimeout(client.connect(transport), timeoutMs, markTimeout);
    const { tools } = await withTimeout(client.listTools(), timeoutMs, markTimeout);
    const toolNames = tools.map((t) => `mcp__${sanitize(s.name)}__${sanitize(t.name)}`);
    return { ok: true, toolNames };
  } catch (e) {
    return { ok: false, toolNames: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    await client.close().catch(() => {});
    // 未暴露 pid 时无法 killTree，只能依赖 client.close()。
    if (timedOut) {
      const pid = readTransportPid(transport);
      if (pid !== undefined) killProbeChild(pid);
    }
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
