import { useEffect } from 'react';
import { useAgentStore, useOptionalAgentStoreContext } from '../../stores/AgentStoreContext';
import type { ChatMessage } from '../../stores/agentReducer';
import { useLayoutStore, selectRightPanelVisible } from '../../stores/layoutStore';
import { selectSubAgentObservation, subAgentObservationUnconfirmed, useSubAgentLiveStore } from '../../stores/subagentLiveStore';
import { SubAgentConversation } from '../panels/SubAgentConversation';
import { followUpCardStatus, isBackgroundSpawn, rememberedSpawnTasks, resolveSpawnTask, subAgentHasResponded, subAgentId, subAgentStartupPhase, subAgentUnitView } from '../panels/subagentUtils';
import type { SubAgentPayload } from '../../stores/dockStore';
import type { DockBodyProps } from './TabBodyRenderer';

type ToolMessage = Extract<ChatMessage, { kind: 'tool' }>;

export function SubAgentBody({ tab, active }: DockBodyProps) {
  const payload = tab.payload as SubAgentPayload;
  const panelOpen = useLayoutStore(selectRightPanelVisible);
  const workspace = useOptionalAgentStoreContext()?.workspace ?? '';
  const store = useAgentStore();
  const sa = store.useStore(
    (s) => s.messages.find((m) => m.kind === 'tool' && m.id === payload.messageId) as ToolMessage | undefined,
  );
  const followedTask = store.useStore((s) => {
    const current = s.messages.find((m) => m.kind === 'tool' && m.id === payload.messageId);
    if (!current || current.kind !== 'tool') return null;
    return resolveSpawnTask(current.args, current.result, rememberedSpawnTasks(s.messages, current.id));
  });
  const view = sa && active && panelOpen
    ? subAgentUnitView(sa.args, sa.result, sa.status, payload.subIndex ?? null)
    : null;
  const agentId = view ? subAgentId(view.result) ?? subAgentId(sa?.result) : null;
  const background = isBackgroundSpawn(view?.result);
  const ownerPath = tab.ownerSessionPath ?? store.getLoadedSessionPath() ?? '';
  const observation = useSubAgentLiveStore(selectSubAgentObservation(workspace, ownerPath, agentId));
  const watch = useSubAgentLiveStore((s) => s.watch);
  useEffect(() => {
    if (!active || !panelOpen || !background || !agentId || !ownerPath ||
      ['done', 'error', 'cancelled', 'interrupted'].includes(observation.item?.status ?? '')) return;
    return watch(workspace, ownerPath, agentId);
  }, [active, panelOpen, background, agentId, ownerPath, workspace, observation.item?.status, watch]);
  const registryRow = observation.item;
  const phase = subAgentStartupPhase({ parentStatus: view?.status ?? 'running', background,
    registry: registryRow, hasResponse: subAgentHasResponded(registryRow), unconfirmed: subAgentObservationUnconfirmed(observation) });
  const registryPath = registryRow?.sessionPath?.trim() || null;
  // 仅在右侧面板打开且本 tab 处于激活态时才渲染会话：
  // dock body 是 keep-alive 常驻挂载的，折叠/非激活时若仍渲染，流式中会每帧解析 transcript 造成卡顿。
  if (!sa || !view || !active || !panelOpen) return null;
  // 单任务 → 复用整条消息（含完整 transcript）；并行/链式 → 取对应子代理的最终输出。
  // 后台 spawn 的工具返回不代表子代理结束；和横条一样按登记表决定详情是否继续收流。
  const status = background && view.status === 'done'
    ? phase === 'done' ? 'done' : phase === 'error' || phase === 'cancelled' || phase === 'interrupted' ? 'error' : 'running'
    : followUpCardStatus(view.status, view.result);
  return (
    <SubAgentConversation
      key={tab.id}
      data-testid={`subagent-${payload.toolCallId}`}
      task={followedTask ?? view.task}
      result={view.result}
      status={status}
      workspace={workspace}
      agentId={agentId}
      sessionPath={background ? registryPath : null}
      phase={phase}
      parentSessionPath={ownerPath}
    />
  );
}
