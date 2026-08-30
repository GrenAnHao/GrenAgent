import { isUnder, pathsEquivalent } from './pathUtils';

/** 记住「上次启动新建的空白对话 cwd」，供下次启动复用，避免每次启动堆积空 works 目录。 */
export const STARTUP_SCRATCH_KEY = 'gren.startupScratchCwd';

/**
 * 记住的空白对话是否仍可复用：必须在 works 目录下，且尚未出现在任何已落盘会话里
 *（即从未被真正使用过——一旦发过消息就会落盘、不再复用，下次启动改为新建）。
 */
export function canReuseScratch(
  remembered: string | null | undefined,
  worksDir: string,
  sessionCwds: Array<string | null | undefined>,
): boolean {
  if (!remembered) return false;
  if (worksDir && !isUnder(remembered, worksDir)) return false;
  return !sessionCwds.some((cwd) => !!cwd && pathsEquivalent(cwd, remembered));
}

/** 读取记住的空白对话 cwd（localStorage 不可用时返回空串）。 */
export function readRememberedScratch(): string {
  try {
    return localStorage.getItem(STARTUP_SCRATCH_KEY) ?? '';
  } catch {
    return '';
  }
}

/** 记住一个新建的空白对话 cwd，供下次启动 / 新建对话复用。 */
export function rememberScratch(cwd: string): void {
  try {
    localStorage.setItem(STARTUP_SCRATCH_KEY, cwd);
  } catch {
    /* ignore */
  }
}

/**
 * 标记某空白对话已被使用（发出首条消息、即将落盘）：若它正是记住的 scratch 就清除记忆。
 * 这是「是否可复用」的首要、即时信号——比依赖 list_all_sessions 落盘更可靠（pi 延迟落盘）。
 */
export function markScratchUsed(cwd: string): void {
  try {
    const remembered = localStorage.getItem(STARTUP_SCRATCH_KEY);
    if (remembered && pathsEquivalent(remembered, cwd)) {
      localStorage.removeItem(STARTUP_SCRATCH_KEY);
    }
  } catch {
    /* ignore */
  }
}
