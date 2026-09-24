import {
  normalizeQuestions,
  type RawQuestion,
} from '@extensions/agent-mode/questions';
import type { AskUserDraft } from '../../electron/agent/askUserDraft';
import { findPendingAskUser } from '../features/chat/pendingAskUser';
import { pi } from '../lib/pi';
import { useInlineQuestionStore } from './inlineQuestionStore';

/** 每个 workspace 的恢复世代：新调用递增，过期的异步结果丢弃。 */
const restoreGenerationByWorkspace = new Map<string, number>();

/**
 * 会话载入后恢复未完成 ask_user 浮层（含草稿）。
 * 读草稿是异步的；调用方不要 await，以免打乱「先补行再算签名」顺序。
 */
export function restoreInlineQuestionOnLoad(
  workspace: string,
  msgs: Array<{ role?: unknown; content?: unknown; toolCallId?: unknown }>,
  sessionPath?: string | null,
): void {
  const generation = (restoreGenerationByWorkspace.get(workspace) ?? 0) + 1;
  restoreGenerationByWorkspace.set(workspace, generation);
  void restoreInlineQuestionOnLoadAsync(workspace, msgs, sessionPath, generation);
}

async function restoreInlineQuestionOnLoadAsync(
  workspace: string,
  msgs: Array<{ role?: unknown; content?: unknown; toolCallId?: unknown }>,
  sessionPath: string | null | undefined,
  generation: number,
): Promise<void> {
  const isCurrent = () => restoreGenerationByWorkspace.get(workspace) === generation;

  const cur = useInlineQuestionStore.getState().byWorkspace[workspace];
  // 活着的等待优先：不要 clear，也不要用 restored 覆盖。
  if (cur?.mode === 'live') return;

  const pending = findPendingAskUser(msgs);
  if (!pending) {
    if (!isCurrent()) return;
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
  if (!data) {
    if (!isCurrent()) return;
    // 题目无法展示：清掉旧 restored，避免和 waiting 行不一致；live 不动。
    if (useInlineQuestionStore.getState().byWorkspace[workspace]?.mode !== 'live') {
      useInlineQuestionStore.getState().clear(workspace);
    }
    return;
  }

  const toolCallId = pending.toolCallId;
  const path = sessionPath ?? undefined;

  // 立刻清掉上一张非 live 卡，避免切会话后旧卡仍可点；草稿就绪前不 setRequest，
  // 否则同 toolCallId 的 draft:null 中间态会让 InlineQuestionCard 灌空选并写盘冲掉草稿。
  if (!isCurrent()) return;
  if (useInlineQuestionStore.getState().byWorkspace[workspace]?.mode !== 'live') {
    useInlineQuestionStore.getState().clear(workspace);
  }

  let draft: AskUserDraft | null = null;
  if (sessionPath) {
    try {
      draft = await pi.readAskUserDraft(workspace, toolCallId);
    } catch {
      draft = null;
    }
  }

  // 过期的异步恢复、或读草稿期间已有现场 live：都不要写。
  if (!isCurrent()) return;
  if (useInlineQuestionStore.getState().byWorkspace[workspace]?.mode === 'live') return;

  useInlineQuestionStore.getState().setRequest({
    workspace,
    id: toolCallId,
    data,
    mode: 'restored',
    toolCallId,
    sessionPath: path,
    draft,
  });
}
