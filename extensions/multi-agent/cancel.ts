// UI / Rust 通过追加 cancel-requests.jsonl 请求取消后台子代理；扩展 fs.watch 消费。

import { appendFileSync, existsSync, mkdirSync, readFileSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { disposeActivation, writeTornDown } from "./activation.js";
import type { SubAgentRegistry } from "./registry.js";

export function cancelRequestDir(cwd: string): string {
  return join(cwd, ".pi", "subagents");
}

export function cancelRequestPath(cwd: string): string {
  return join(cancelRequestDir(cwd), "cancel-requests.jsonl");
}

export function appendCancelRequest(cwd: string, agentId: string): void {
  const path = cancelRequestPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ agentId, at: Date.now() })}\n`, "utf8");
}

export type CancelHandler = (agentId: string) => void;

/** Abort an in-flight sub-agent and mark the registry row cancelled. */
export function cancelSubAgent(
  agentId: string,
  registry: SubAgentRegistry,
  inflight: Map<string, AbortController>,
): void {
  const row = registry.get(agentId);
  if (!row || row.status !== "running") return;
  writeTornDown(agentId, row.sessionPath);
  inflight.get(agentId)?.abort();
  registry.finish(agentId, { status: "cancelled", exitCode: -1 });
  inflight.delete(agentId);
  void disposeActivation(agentId, "cancel");
}

const watchers = new Map<string, () => void>();

export function drainCancelRequests(cwd: string, offset: { lines: number }, onCancel: CancelHandler): void {
  const path = cancelRequestPath(cwd);
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  for (let i = offset.lines; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]) as { agentId?: string };
      if (parsed.agentId?.trim()) onCancel(parsed.agentId.trim());
    } catch {
      /* ignore malformed lines */
    }
  }
  offset.lines = lines.length;
}

/** Watch <cwd>/.pi/subagents for cancel-requests.jsonl appends. Idempotent per cwd. */
export function installCancelWatcher(cwd: string, onCancel: CancelHandler): () => void {
  const existing = watchers.get(cwd);
  if (existing) return existing;

  const dir = cancelRequestDir(cwd);
  mkdirSync(dir, { recursive: true });
  const offset = { lines: 0 };
  const drain = () => drainCancelRequests(cwd, offset, onCancel);
  drain();

  const watcher = watch(dir, () => drain());
  watcher.on("error", () => {});

  const unwatch = () => {
    watcher.close();
    watchers.delete(cwd);
  };
  watchers.set(cwd, unwatch);
  return unwatch;
}

function normalizeCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Stop watching `<cwd>/.pi/subagents`. Path-tolerant. Idempotent if none installed. */
export function uninstallCancelWatcher(cwd: string): boolean {
  const exact = watchers.get(cwd);
  if (exact) {
    exact();
    return true;
  }
  const want = normalizeCwd(cwd);
  for (const key of [...watchers.keys()]) {
    if (normalizeCwd(key) !== want) continue;
    watchers.get(key)?.();
    return true;
  }
  return false;
}
