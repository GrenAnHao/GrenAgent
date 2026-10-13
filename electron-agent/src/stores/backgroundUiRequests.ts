import { pathsEquivalent } from '../lib/pathUtils';
import { useInlineQuestionStore, type InlineQuestionItem } from './inlineQuestionStore';
import { useUiPromptStore, type UiPromptItem } from './uiPromptStore';

/**
 * 不在画面上的会话发来的交互请求（ask_user 卡、confirm / select / input）。
 * 两个 store 都按 workspace 显示，直接写进去会把后台会话的卡显示在当前会话上。
 * 先按 sessionPath 暂存，切到那个会话时再放回去。
 */
interface Stashed {
  inline?: InlineQuestionItem;
  prompts: UiPromptItem[];
}

const stash = new Map<string, Stashed>();

function keyOf(sessionPath: string): string | undefined {
  for (const key of stash.keys()) if (pathsEquivalent(key, sessionPath)) return key;
  return undefined;
}

function entry(sessionPath: string): Stashed {
  const key = keyOf(sessionPath) ?? sessionPath;
  const found = stash.get(key) ?? { prompts: [] };
  stash.set(key, found);
  return found;
}

function isSubagentRequest(item: UiPromptItem): boolean {
  return Array.isArray(item.request.subagents) && item.request.subagents.length > 0;
}

export function stashInlineQuestion(sessionPath: string, item: InlineQuestionItem): void {
  entry(sessionPath).inline = { ...item, sessionPath };
}

export function stashUiPrompt(sessionPath: string, item: UiPromptItem): void {
  const found = entry(sessionPath);
  const stamped = { ...item, sessionPath, receivedAt: item.receivedAt ?? Date.now() };
  const at = found.prompts.findIndex((p) => p.request.id === item.request.id);
  if (at >= 0) found.prompts[at] = stamped;
  else found.prompts.push(stamped);
}

/** 切走时把画面上属于 sessionPath 的现场请求收起来，不能直接清掉：后端那次请求还在等回包。 */
export function parkVisibleUiRequests(workspace: string, sessionPath: string): void {
  const inline = useInlineQuestionStore.getState().byWorkspace[workspace];
  if (inline?.mode === 'live' && (!inline.sessionPath || pathsEquivalent(inline.sessionPath, sessionPath))) {
    stashInlineQuestion(sessionPath, inline);
    useInlineQuestionStore.getState().clear(workspace, inline.id);
  }
  const taken = useUiPromptStore
    .getState()
    .takeWhere(workspace, (p) => !p.sessionPath || pathsEquivalent(p.sessionPath, sessionPath));
  for (const prompt of taken) stashUiPrompt(sessionPath, prompt);
}

/** 切到 sessionPath 后把暂存的请求放回画面，按原来的顺序排队。 */
export function restoreStashedUiRequests(workspace: string, sessionPath: string): void {
  const key = keyOf(sessionPath);
  if (!key) return;
  const found = stash.get(key)!;
  stash.delete(key);
  if (found.inline) useInlineQuestionStore.getState().setRequest({ ...found.inline, workspace });
  for (const prompt of found.prompts) useUiPromptStore.getState().setRequest({ ...prompt, workspace });
}

/**
 * 会话这一轮结束后，它挂着的请求也已经失效。子代理经它发来的审批不算：
 * 子代理的这一轮还在等，宿主到点或撤回时会发 dismiss。
 * 会话进程退出（hostGone）时宿主已经不在，不会再有 dismiss，子代理的请求一起丢掉。
 */
export function dropStashedUiRequests(sessionPath: string, opts: { hostGone?: boolean } = {}): void {
  const key = keyOf(sessionPath);
  if (!key) return;
  const kept = opts.hostGone ? [] : stash.get(key)!.prompts.filter(isSubagentRequest);
  if (kept.length) stash.set(key, { prompts: kept });
  else stash.delete(key);
}

/** 宿主不再等这条请求：画面上、排队中、后台暂存里都摘掉。ask_user 卡不经这里。 */
export function dismissUiRequest(id: string): void {
  useUiPromptStore.getState().dismiss(id);
  for (const [key, found] of stash) {
    const prompts = found.prompts.filter((p) => p.request.id !== id);
    if (prompts.length === found.prompts.length) continue;
    if (prompts.length || found.inline) stash.set(key, { ...found, prompts });
    else stash.delete(key);
  }
}

export function hasStashedUiRequests(sessionPath: string): boolean {
  return keyOf(sessionPath) !== undefined;
}

export function clearStashedUiRequestsForTest(): void {
  stash.clear();
}
