import { sessionControlKey } from './modeStore';
import type { UiPromptItem } from './uiPromptStore';
import type { InlineQuestionItem } from './inlineQuestionStore';
import type { VisualEntry } from './visualStore';
import type { StashedUiRequests } from './backgroundUiRequests';

/** 某个会话正在等用户处理的请求。同一会话里审批压过选择。 */
export interface PendingEntry {
  path: string;
  workspace: string;
  kind: 'approval' | 'choice';
  title?: string;
}

export interface PendingSources {
  /** uiPromptStore 的 byWorkspace + waiting 摊平，显示中的在前。 */
  prompts: UiPromptItem[];
  /** inlineQuestionStore.byWorkspace 的值（live 和 restored 都算）。 */
  inline: InlineQuestionItem[];
  /** visualStore.entries 的值，只用 pending 为 true 的。 */
  visual: VisualEntry[];
  stashed: StashedUiRequests[];
  /** 请求没带 sessionPath 时归到该工作区画面上的会话；返回 undefined 就丢掉这条。 */
  ownerOf: (workspace: string) => string | undefined;
}

const VISUAL_TITLE = '视觉设计等待确认';

function promptTitle(item: UiPromptItem): string | undefined {
  const { title, message } = item.request;
  if (typeof title === 'string' && title.trim()) return title;
  if (typeof message === 'string' && message.trim()) return message;
  return undefined;
}

function questionTitle(item: InlineQuestionItem): string | undefined {
  const title = item.data.questions?.[0]?.title;
  return typeof title === 'string' && title.trim() ? title : undefined;
}

/**
 * 从现有的几个请求 store 派生「哪个会话在等用户」。不单独按请求 id 记账：答复、撤回、回合结束、
 * 切会话暂存这些分支已经由那几个 store 处理，派生跟着它们走就不会漏灭。键为 sessionControlKey。
 */
export function derivePending(src: PendingSources): Record<string, PendingEntry> {
  const out: Record<string, PendingEntry> = {};
  const add = (path: string | null | undefined, workspace: string, kind: PendingEntry['kind'], title: string | undefined) => {
    const resolved = path || src.ownerOf(workspace);
    if (!resolved) return;
    const key = sessionControlKey(resolved);
    const prev = out[key];
    if (prev && (prev.kind === 'approval' || kind === 'choice')) return;
    out[key] = { path: resolved, workspace, kind, ...(title ? { title } : {}) };
  };

  for (const item of src.prompts) add(item.sessionPath, item.workspace, 'approval', promptTitle(item));
  for (const found of src.stashed) {
    for (const item of found.prompts) add(found.sessionPath, item.workspace, 'approval', promptTitle(item));
  }
  for (const item of src.inline) add(item.sessionPath, item.workspace, 'choice', questionTitle(item));
  for (const found of src.stashed) {
    if (found.inline) add(found.sessionPath, found.inline.workspace, 'choice', questionTitle(found.inline));
  }
  for (const entry of src.visual) {
    if (entry.pending) add(entry.sessionPath, entry.workspace, 'choice', VISUAL_TITLE);
  }
  return out;
}
