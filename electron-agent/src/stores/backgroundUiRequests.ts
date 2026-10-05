import { pathsEquivalent } from '../lib/pathUtils';
import { useInlineQuestionStore, type InlineQuestionItem } from './inlineQuestionStore';
import { useUiPromptStore, type UiPromptItem } from './uiPromptStore';

/**
 * 不在画面上的会话发来的交互请求（ask_user 卡、confirm / select / input）。
 * 两个 store 都按 workspace 只放一条，直接写进去会把后台会话的卡显示在当前会话上。
 * 先按 sessionPath 暂存，切到那个会话时再放回去。
 */
interface Stashed {
  inline?: InlineQuestionItem;
  prompt?: UiPromptItem;
}

const stash = new Map<string, Stashed>();

function keyOf(sessionPath: string): string | undefined {
  for (const key of stash.keys()) if (pathsEquivalent(key, sessionPath)) return key;
  return undefined;
}

function entry(sessionPath: string): Stashed {
  const key = keyOf(sessionPath) ?? sessionPath;
  const found = stash.get(key) ?? {};
  stash.set(key, found);
  return found;
}

export function stashInlineQuestion(sessionPath: string, item: InlineQuestionItem): void {
  entry(sessionPath).inline = { ...item, sessionPath };
}

export function stashUiPrompt(sessionPath: string, item: UiPromptItem): void {
  entry(sessionPath).prompt = { ...item, sessionPath };
}

/** 切走时把画面上属于 sessionPath 的现场请求收起来，不能直接清掉：后端那次请求还在等回包。 */
export function parkVisibleUiRequests(workspace: string, sessionPath: string): void {
  const inline = useInlineQuestionStore.getState().byWorkspace[workspace];
  if (inline?.mode === 'live' && (!inline.sessionPath || pathsEquivalent(inline.sessionPath, sessionPath))) {
    stashInlineQuestion(sessionPath, inline);
    useInlineQuestionStore.getState().clear(workspace, inline.id);
  }
  const prompt = useUiPromptStore.getState().byWorkspace[workspace];
  if (prompt && (!prompt.sessionPath || pathsEquivalent(prompt.sessionPath, sessionPath))) {
    stashUiPrompt(sessionPath, prompt);
    useUiPromptStore.getState().clear(workspace, prompt.request.id);
  }
}

/** 切到 sessionPath 后把暂存的请求放回画面。 */
export function restoreStashedUiRequests(workspace: string, sessionPath: string): void {
  const key = keyOf(sessionPath);
  if (!key) return;
  const found = stash.get(key)!;
  stash.delete(key);
  if (found.inline) useInlineQuestionStore.getState().setRequest({ ...found.inline, workspace });
  if (found.prompt) useUiPromptStore.getState().setRequest({ ...found.prompt, workspace });
}

/** 会话这一轮结束后，它挂着的请求也已经失效。 */
export function dropStashedUiRequests(sessionPath: string): void {
  const key = keyOf(sessionPath);
  if (key) stash.delete(key);
}

export function hasStashedUiRequests(sessionPath: string): boolean {
  return keyOf(sessionPath) !== undefined;
}

export function clearStashedUiRequestsForTest(): void {
  stash.clear();
}
