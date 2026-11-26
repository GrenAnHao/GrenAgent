import { buildGoalStatus } from '../../../extensions/goal/status.js';
import { getSessionPlan } from '../../../extensions/agent-mode/planState.js';

/** Facts from the owning runtime, not the renderer's running indicator. */
export interface TransferActivityFacts {
  sessionId: string;
  entries: unknown[];
  session?: { isIdle?: boolean; isStreaming?: boolean; isCompacting?: boolean; pendingMessageCount?: number; cacheWarmingStatus?: { state: string } };
  hasPendingUi?: () => boolean;
  activeTurn: boolean;
  queuedTurns: number;
  preferenceWritePending: boolean;
  structuralOperationPending: boolean;
  hasLiveJobs: boolean | undefined;
}

export function sessionTransferBusyReason(facts: TransferActivityFacts): string | undefined {
  if (facts.hasLiveJobs === undefined) return '无法确认后台任务状态，请稍后重试';
  if (facts.hasLiveJobs) return '此会话仍有后台任务运行，请等待任务结束';
  if (facts.activeTurn) return '此会话正在执行，请等待本轮结束';
  if (facts.queuedTurns > 0) return '此会话有排队中的消息，请等待处理结束';
  if (facts.preferenceWritePending) return '会话偏好正在保存，请稍后重试';
  if (facts.structuralOperationPending) return '会话正在修改或等待恢复';
  if (facts.session) {
    // An already in-flight refresh can still append usage; never cancel it or snapshot through it.
    if (facts.session.cacheWarmingStatus?.state === 'refreshing') return '缓存预热请求尚未结束，请稍后重试';
    if (facts.session.isIdle !== true) return '会话尚未空闲，请等待本轮及工具结束';
    if (facts.session.isStreaming || facts.session.isCompacting || (facts.session.pendingMessageCount ?? 0) > 0) {
      return '会话正在执行、压缩或等待消息处理';
    }
    if (!facts.hasPendingUi) return '无法确认会话交互状态，请稍后重试';
    if (facts.hasPendingUi()) return '会话正在等待批准或选择，请先完成交互';
  }
  const goal = buildGoalStatus({ entries: facts.entries, sessionId: facts.sessionId }).snapshot;
  // Disarmed is an in-memory fact: an active persisted Goal can be armed again
  // by the target's autoContinueOnOpen policy. Require an actual persisted pause.
  if (goal?.activation === 'armed' || goal?.status === 'active') return '会话目标仍生效，请先暂停目标续跑';
  const plan = getSessionPlan(facts.sessionId);
  if (plan?.status === 'executing' || plan?.status === 'confirmed') return '会话计划仍在执行，请先完成或取消计划';
  // A detached persisted plan must not be restarted in a new project by opening it.
  for (let i = facts.entries.length - 1; i >= 0; i--) {
    const entry = facts.entries[i] as { type?: string; customType?: string; data?: { plan?: { status?: string }; status?: string } };
    if (entry?.type !== 'custom' || entry.customType !== 'agent-mode') continue;
    const status = entry.data?.plan?.status;
    if (status === 'executing' || status === 'confirmed') return '会话计划仍在执行，请先完成或取消计划';
    break;
  }
  return undefined;
}
