import { spawn, type ChildProcess } from "node:child_process";

const byCwd = new Map<string, Set<ChildProcess>>();

export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
    } catch {
      /* fall through */
    }
    try { child.kill(); } catch { /* gone */ }
    return;
  } else {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      /* 不是组长或已退：落到 child.kill */
    }
  }
  try { child.kill(); } catch { /* gone */ }
}

export function registerSubagentProcess(cwd: string, child: ChildProcess): () => void {
  let set = byCwd.get(cwd);
  if (!set) {
    set = new Set();
    byCwd.set(cwd, set);
  }
  set.add(child);
  const remove = (): void => {
    set!.delete(child);
    if (set!.size === 0) byCwd.delete(cwd);
  };
  child.once?.("exit", remove);
  return remove;
}

export function killSubagentsFor(cwd: string): void {
  const set = byCwd.get(cwd);
  if (!set) return;
  for (const child of [...set]) killProcessTree(child);
}

export function killAllSubagents(): void {
  for (const cwd of [...byCwd.keys()]) killSubagentsFor(cwd);
}

export function __resetSubagentProcessesForTest(): void {
  byCwd.clear();
}
