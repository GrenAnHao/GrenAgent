import type { AgentMessage } from '../lib/pi';
import { thinkingDurationLookup } from '../lib/thinkingDurations';
import { findPendingAskUser } from '../features/chat/pendingAskUser';
import { messagesFromAgent, type ChatMessage } from './agentReducer';
import { applyPendingAskUserOnLoad } from './pendingAskUserLoad';
import { reconcileRuleInjectionNotices, reconcileTodoResults } from './sessionMessageSync';
import { enrichHistorySources } from './sessionTransferHistoryMerge';

export interface SnapshotOptions {
  /**
   * 迁移来源（fromWorkspace）：ui-history 比后端长、且有旧辅助条目没有 entryId 映射时，
   * 用这个根兜底，不让它们退回目标项目。未迁移时不传。
   */
  fallbackSource?: string;
  /**
   * 后端明确报告的当前确认位置。`null` 表示空根：即使旧 ui-history 更长，也不能把它当成
   * 当前会话内容（它只是迁移前的历史参考，不是当前 leaf）。缺省 = 后端没报告，按旧行为处理。
   */
  backendLeaf?: string | null;
}

/**
 * 从 backend 行推断历史来源根：所有带 sourceCwd 的行都指向同一个值时采用。
 * 冷启动没有运行期迁移登记时靠它恢复旧 ui-history 辅助条目的来源；多个来源则返回 undefined，不猜。
 */
export function inferHistorySource(msgs: readonly AgentMessage[]): string | undefined {
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  let only: string | undefined;
  for (const message of msgs) {
    const raw = (message as { sourceCwd?: unknown }).sourceCwd;
    if (typeof raw !== 'string' || !raw.trim()) continue;
    if (only === undefined) only = normalize(raw);
    else if (only !== normalize(raw)) return undefined;
  }
  if (only === undefined) return undefined;
  for (const message of msgs) {
    const raw = (message as { sourceCwd?: unknown }).sourceCwd;
    if (typeof raw === 'string' && raw.trim() && normalize(raw) === only) return raw;
  }
  return undefined;
}

/**
 * 后端快照 → 界面消息。UI 完整历史更长时用它（压缩后后端历史会变短），并补回未完成的 ask_user 行。
 *
 * 主代理载入会话和子代理详情读 JSONL 种子都走这一条，历史怎么变成界面消息只有一种答案。
 * ui-history 更长时先把后端行的来源（sourceCwd / sourceRefs）贴回旧行：迁移过项目的会话不能因为
 * ui-history 更长就把旧相对路径解释到目标项目。
 */
export function snapshotMessages(msgs: AgentMessage[], uiHistory?: ChatMessage[], options?: SnapshotOptions) {
  const backend = messagesFromAgent(msgs, thinkingDurationLookup());
  // 空根（后端明确 leaf === null）不能被更长的旧 ui-history 冒充成当前内容。
  const emptyRoot = options?.backendLeaf === null && backend.length === 0;
  const longer = !emptyRoot && uiHistory && uiHistory.length > backend.length ? uiHistory : undefined;
  const fallbackSource = options?.fallbackSource ?? inferHistorySource(msgs);
  const enriched = longer ? enrichHistorySources(longer, backend, fallbackSource) : undefined;
  const history = enriched ? enriched.messages : backend;
  const processed = history === backend ? backend : reconcileRuleInjectionNotices(
    reconcileTodoResults(history, backend), backend, options?.backendLeaf !== undefined,
  );
  return {
    backend,
    processed,
    sanitized: applyPendingAskUserOnLoad(processed, findPendingAskUser(msgs)),
    pendingCallIds: pendingCallIdsOf(backend),
    /** ui-history 被补过来源：调用方应把补好的内容写回，避免下次重挂又丢。 */
    historySourcesPatched: Boolean(enriched?.changed),
    /** 后端明确是空根：界面显示空会话，不把旧 ui-history 当当前 leaf。 */
    emptyRoot,
  };
}

/**
 * 后端快照里还在等结果的调用（messagesFromAgent 只给最后一条助手消息补 running 卡）。
 * 回合在跑时只有它们还可能等到结果；UI 历史里别的 running 卡是进程被杀时留下的。
 */
function pendingCallIdsOf(backend: ChatMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of backend) {
    if (m.kind === 'tool' && m.status === 'running' && m.result === undefined) ids.add(m.toolCallId);
  }
  return ids;
}
