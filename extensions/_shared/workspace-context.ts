import { AsyncLocalStorage } from "node:async_hooks";

export type ToolOrigin = "main" | "goal" | "subagent";

/** 进程内嵌宿主的每回合上下文。origin 只有 main / goal；subagent 只出现在 fork 子进程（无 ALS，由 env 判定）。 */
export interface WorkspaceContext {
  origin: "main" | "goal";
  workspace: string;
  cwd: string;
  config: Readonly<Record<string, string>>;
}

const storage = new AsyncLocalStorage<WorkspaceContext>();

export function runInWorkspace<T>(ctx: WorkspaceContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentWorkspaceContext(): WorkspaceContext | undefined {
  return storage.getStore();
}

/** 无 ALS 时回退 process.cwd()：fork 子进程与未包裹的 CLI 路径按进程 cwd 即正确。 */
export function currentCwd(): string {
  return storage.getStore()?.cwd ?? process.cwd();
}

export function resolveToolOrigin(): ToolOrigin {
  const ctx = storage.getStore();
  if (ctx) return ctx.origin;
  return process.env.PI_IS_SUBAGENT === "1" ? "subagent" : "main";
}
