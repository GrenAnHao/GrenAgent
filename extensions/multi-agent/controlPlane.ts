// In-process sub-agent control plane: one open SQLite registry + cancel watcher per cwd.
// session_start / spawn_agent keep these alive for the workspace lifetime; deleting or
// disposing the workspace must close them or Windows cannot unlink registry.db.

import { join } from "node:path";
import { disposeActivation, disposeResident, disposeResidentsWhere, getActivation, getActivationBySessionPath } from "./activation.js";
import { silenceChild } from "./child-runs.js";
import { SubAgentRegistry } from "./registry.js";
import { cancelSubAgent, installCancelWatcher, uninstallCancelWatcher } from "./cancel.js";
import { killSubagentsFor } from "./subagentProcessRegistry.js";

const registries = new Map<string, SubAgentRegistry>();
export const inflight = new Map<string, AbortController>();

/** 中止后等后台一次性运行跑完的上限；超时也继续删（尽力而为）。 */
const INFLIGHT_SETTLE_MS = 5000;
const INFLIGHT_POLL_MS = 20;

function normalizeCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function findOpenRegistry(cwd: string): SubAgentRegistry | undefined {
  const want = normalizeCwd(cwd);
  for (const [key, reg] of registries) {
    if (normalizeCwd(key) === want) return reg;
  }
  return undefined;
}

export function getRegistry(cwd: string): SubAgentRegistry {
  let reg = registries.get(cwd);
  if (!reg) {
    for (const [key, existing] of registries) {
      if (normalizeCwd(key) === normalizeCwd(cwd)) {
        registries.set(cwd, existing);
        return existing;
      }
    }
    reg = new SubAgentRegistry(join(cwd, ".pi", "subagents", "registry.db"));
    reg.load();
    reg.reapOrphans();
    registries.set(cwd, reg);
    installCancelWatcher(cwd, (agentId) => cancelSubAgent(agentId, reg!, inflight));
  }
  return reg;
}

export function forEachRegistry(fn: (reg: SubAgentRegistry) => void): void {
  for (const reg of registries.values()) fn(reg);
}

export function releaseSubagentControlPlane(cwd: string): { released: string[] } {
  killSubagentsFor(cwd);
  disposeResidentsWhere((r) => normalizeCwd(r.workspace) === normalizeCwd(cwd));
  const want = normalizeCwd(cwd);
  const released: string[] = [];
  for (const key of [...registries.keys()]) {
    if (normalizeCwd(key) !== want) continue;
    try {
      registries.get(key)?.close();
    } catch {
      /* close 失败仍要摘掉引用，避免删目录时继续占着句柄 */
    }
    registries.delete(key);
    uninstallCancelWatcher(key);
    released.push(key);
  }
  uninstallCancelWatcher(cwd);
  return { released };
}

/**
 * 删子会话 JSONL 前的收口（父会话被删时级联调用）。驻留 Activation 直接拆、不给即将删除的父会话发结算；
 * 在途的后台一次性运行先静默（否则结算 notice 会唤醒正在删除的父会话）再中止，并等它跑完——
 * SessionManager 逐条 append，跑完前删文件会被尾部 append 重建成无头文件。
 * 必须在 releaseSubagentControlPlane 之前调用：registry 关掉后，子级收尾的 finish 会把 registry.db 懒重建回去。
 * 返回 quiescent=false 表示等超时、子级可能还在写；调用方应保留文件（隐藏）而不是删它。
 */
export async function releaseChildForDelete(
  cwd: string,
  agentId: string | null,
  sessionPath: string,
  opts: { settleTimeoutMs?: number } = {},
): Promise<{ quiescent: boolean }> {
  const registry = findOpenRegistry(cwd);
  if (agentId) {
    silenceChild(agentId);
    disposeResident(agentId);
  }

  const act = (agentId ? getActivation(agentId) : undefined) ?? getActivationBySessionPath(sessionPath);
  if (act) {
    await disposeActivation(act.childId, "rollback");
    inflight.get(act.childId)?.abort();
    inflight.delete(act.childId);
    if (registry?.get(act.childId)?.status === "running") {
      registry.finish(act.childId, { status: "cancelled", exitCode: -1 });
    }
    return { quiescent: true };
  }

  const controller = agentId ? inflight.get(agentId) : undefined;
  if (!controller || !agentId) return { quiescent: true };
  controller.abort();
  await waitUntil(() => !inflight.has(agentId), opts.settleTimeoutMs ?? INFLIGHT_SETTLE_MS);
  return { quiescent: !inflight.has(agentId) };
}

async function waitUntil(done: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, INFLIGHT_POLL_MS));
  }
}

export function __resetSubagentControlPlaneForTest(): void {
  for (const [key, reg] of registries) {
    try {
      reg.close();
    } catch {
      /* test cleanup */
    }
    uninstallCancelWatcher(key);
  }
  registries.clear();
  inflight.clear();
}
