// 每会话工作目录（子代理重新设计阶段 2.5，照 DSH 的 session working directory）。
//
// Pi SDK 1.1.0 没有改活会话 cwd 的接口。内置工具（bash/read/write/edit/ls/find/grep）和扩展看到的
// ctx.cwd 都在调用时现读 extensionRunner.cwd；系统提示里的 <cwd> 和 reload 后重建工具读私有字段
// AgentSession._cwd。这里原地改这两个字段（两处私有访问只在 applyCwd 里），并把每次切换写成会话里的
// custom entry `working_directory`，会话打开时按最后一条恢复。
//
// 不变的：会话头里的 cwd（原始目录，会话归属与会话目录都按它）、process.cwd()、已经起来的进程。
// 权限根与项目身份（审批、沙箱、注册表、记忆……）按 projectCwd(ctx) 取原始目录，不跟着切换。

import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

export const WORKING_DIRECTORY_ENTRY = "working_directory";

/** 一个活会话里本模块要用到的部分（AgentSession 满足它）。 */
export interface CwdSession {
  readonly sessionId: string;
  readonly sessionManager: {
    getCwd(): string;
    getEntries(): readonly unknown[];
    appendCustomEntry(customType: string, data?: unknown): unknown;
  };
  readonly extensionRunner?: unknown;
}

export interface CwdChange {
  previous: string;
  cwd: string;
  changed: boolean;
}

export interface SessionCwdController {
  /** 会话头里的原始目录。 */
  original(): string;
  current(): string;
  /** 切到一个已存在的目录（相对路径按当前目录解析），写进会话。目录不存在时抛错。 */
  set(target: string): CwdChange;
}

interface WorkingDirectoryData {
  cwd?: unknown;
}

/** 会话的原始目录（会话头 cwd）。拿不到会话管理器时退回 ctx.cwd。 */
export function projectCwd(ctx: { cwd: string; sessionManager?: unknown }): string {
  try {
    const cwd = (ctx.sessionManager as { getCwd?: () => string } | undefined)?.getCwd?.();
    if (typeof cwd === "string" && cwd.trim()) return cwd;
  } catch {
    /* 上下文已失效 */
  }
  return ctx.cwd;
}

/** 会话里最后一次记下的工作目录；没有记录时 undefined。 */
export function recordedCwd(entries: readonly unknown[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type?: string; customType?: string; data?: WorkingDirectoryData } | undefined;
    if (entry?.type !== "custom" || entry.customType !== WORKING_DIRECTORY_ENTRY) continue;
    const cwd = entry.data?.cwd;
    return typeof cwd === "string" && cwd.trim() ? cwd : undefined;
  }
  return undefined;
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

export function sameDirectory(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = resolve(p).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

function currentOf(session: CwdSession): string {
  const runner = session.extensionRunner as { cwd?: unknown } | undefined;
  if (typeof runner?.cwd === "string" && runner.cwd) return runner.cwd;
  const own = (session as unknown as { _cwd?: unknown })._cwd;
  return typeof own === "string" && own ? own : session.sessionManager.getCwd();
}

/** 原地改活会话的 cwd。SDK 私有字段：ExtensionRunner.cwd（runner.js），AgentSession._cwd（agent-session.js）。 */
function applyCwd(session: CwdSession, cwd: string): void {
  const runner = session.extensionRunner as { cwd?: string } | undefined;
  if (runner && typeof runner === "object") runner.cwd = cwd;
  (session as unknown as { _cwd?: string })._cwd = cwd;
}

const controllers = new Map<string, SessionCwdController>();

/**
 * 给活会话挂上工作目录控制器：按会话里最后一条记录恢复目录（记录的目录已经不在时退回原始目录并记下），
 * 再按 sessionId 登记，供 working_directory / create_worktree 找到调用方自己的会话。返回解除登记的函数。
 */
export function attachSessionCwd(session: CwdSession): () => void {
  if (typeof session?.sessionManager?.getCwd !== "function" || !session.sessionId) return () => {};
  const original = () => session.sessionManager.getCwd();
  const persist = (cwd: string, extra: Record<string, unknown> = {}) => {
    session.sessionManager.appendCustomEntry(WORKING_DIRECTORY_ENTRY, { cwd, ...extra });
  };

  const recorded = recordedCwd(session.sessionManager.getEntries());
  if (recorded && !sameDirectory(recorded, currentOf(session))) {
    if (isDirectory(recorded)) {
      applyCwd(session, recorded);
    } else {
      applyCwd(session, original());
      persist(original(), { unavailable: recorded });
    }
  }

  const controller: SessionCwdController = {
    original,
    current: () => currentOf(session),
    set(target) {
      const previous = currentOf(session);
      const trimmed = target.trim();
      if (!trimmed) throw new Error("working directory must not be empty");
      const resolved = resolve(previous, trimmed);
      if (!isDirectory(resolved)) throw new Error(`working directory does not exist: "${resolved}"`);
      const cwd = canonical(resolved);
      if (sameDirectory(cwd, previous)) return { previous, cwd: previous, changed: false };
      applyCwd(session, cwd);
      persist(cwd);
      return { previous, cwd, changed: true };
    },
  };
  const id = session.sessionId;
  controllers.set(id, controller);
  return () => {
    if (controllers.get(id) === controller) controllers.delete(id);
  };
}

export function sessionCwdController(sessionId: string | undefined): SessionCwdController | undefined {
  return sessionId ? controllers.get(sessionId) : undefined;
}

export function __resetSessionCwdForTest(): void {
  controllers.clear();
}
