import {
  normalizeQuestions,
  type RawQuestion,
} from '@extensions/agent-mode/questions';
import type { AskUserDraft } from '../../electron/agent/askUserDraft';
import { findPendingAskUser } from '../features/chat/pendingAskUser';
import { pi } from '../lib/pi';
import { useInlineQuestionStore } from './inlineQuestionStore';

/**
 * 会话载入后恢复未完成 ask_user 浮层（含草稿）。
 * 读草稿是异步的；调用方不要 await，以免打乱「先补行再算签名」顺序。
 */
export function restoreInlineQuestionOnLoad(
  workspace: string,
  msgs: Array<{ role?: unknown; content?: unknown; toolCallId?: unknown }>,
  sessionPath?: string | null,
): void {
  void restoreInlineQuestionOnLoadAsync(workspace, msgs, sessionPath);
}

async function restoreInlineQuestionOnLoadAsync(
  workspace: string,
  msgs: Array<{ role?: unknown; content?: unknown; toolCallId?: unknown }>,
  sessionPath?: string | null,
): Promise<void> {
  const cur = useInlineQuestionStore.getState().byWorkspace[workspace];
  // 活着的等待优先：不要 clear，也不要用 restored 覆盖。
  if (cur?.mode === 'live') return;

  const pending = findPendingAskUser(msgs);
  if (!pending) {
    useInlineQuestionStore.getState().clear(workspace);
    return;
  }

  const raw = pending.args as {
    questions?: RawQuestion[];
    allowExtra?: boolean;
    allowExtraImages?: boolean;
    extraPlaceholder?: string;
  };
  const data = normalizeQuestions(raw.questions ?? [], pending.toolCallId, raw);
  if (!data) return;

  let draft: AskUserDraft | null = null;
  if (sessionPath) {
    try {
      draft = await pi.readAskUserDraft(workspace, pending.toolCallId);
    } catch {
      draft = null;
    }
  }

  // 读草稿期间可能已有现场 live 请求；不要盖掉它。
  if (useInlineQuestionStore.getState().byWorkspace[workspace]?.mode === 'live') return;

  useInlineQuestionStore.getState().setRequest({
    workspace,
    id: pending.toolCallId,
    data,
    mode: 'restored',
    toolCallId: pending.toolCallId,
    sessionPath: sessionPath ?? undefined,
    draft,
  });
}
