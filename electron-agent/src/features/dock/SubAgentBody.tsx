import { useEffect, useState } from 'react';
import { useAgentStore, useOptionalAgentStoreContext } from '../../stores/AgentStoreContext';
import type { ChatMessage } from '../../stores/agentReducer';
import { useLayoutStore, selectRightPanelVisible } from '../../stores/layoutStore';
import { selectSubAgentById, useSubAgentLiveStore } from '../../stores/subagentLiveStore';
import { SubAgentConversation } from '../panels/SubAgentConversation';
import { backgroundRegistryStatus, followUpCardStatus, isBackgroundSpawn, mapSubAgentStatus, rememberedSpawnTasks, resolveSpawnTask, subAgentId, subAgentUnitView } from '../panels/subagentUtils';
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
  const registryRow = useSubAgentLiveStore(selectSubAgentById(workspace, agentId));
  const registryLoaded = useSubAgentLiveStore((s) => s.itemsByWorkspace.has(workspace));
  const [seenRegistry, setSeenRegistry] = useState<{ agentId: string; status: string; sessionPath: string | null } | null>(null);
  const seen = seenRegistry?.agentId === agentId ? seenRegistry : null;
  const registryStatus = registryLoaded && agentId
    ? backgroundRegistryStatus(registryRow)
    : seen?.status ?? 'running';
  // 后台回执里没有 sessionPath，只有登记表行有。详情在标签隐藏时会卸载，路径记在常驻的 body 里。
  const registryPath = registryRow?.sessionPath?.trim() || seen?.sessionPath || null;
  useEffect(() => {
    if (!background || !registryLoaded || !agentId) return;
    // 最后一个轮询消费者结束后 store 会清空；沿用已见终态和路径，避免又把详情当作后台运行中、退回 transcript 回放。
    const status = backgroundRegistryStatus(registryRow);
    setSeenRegistry((prev) => {
      const sessionPath = registryRow?.sessionPath?.trim() || (prev?.agentId === agentId ? prev.sessionPath : null);
      return prev?.agentId === agentId && prev.status === status && prev.sessionPath === sessionPath
        ? prev
        : { agentId, status, sessionPath };
    });
  }, [background, registryLoaded, registryRow, agentId]);
  // 仅在右侧面板打开且本 tab 处于激活态时才渲染会话：
  // dock body 是 keep-alive 常驻挂载的，折叠/非激活时若仍渲染，流式中会每帧解析 transcript 造成卡顿。
  if (!sa || !view || !active || !panelOpen) return null;
  // 单任务 → 复用整条消息（含完整 transcript）；并行/链式 → 取对应子代理的最终输出。
  // 后台 spawn 的工具返回不代表子代理结束；和横条一样按登记表决定详情是否继续收流。
  const status = background && view.status === 'done'
    ? registryStatus === 'interrupted' ? 'error' : mapSubAgentStatus(registryStatus)
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
    />
  );
}
