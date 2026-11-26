import { useEffect, useState } from 'react';
import { useSubAgentLiveStore, selectSubAgentById, selectSubAgentObservation, subAgentObservationUnconfirmed } from '../../stores/subagentLiveStore';
import { useOptionalAgentStoreContext } from '../../stores/AgentStoreContext';
import type { SubAgentLogPayload } from '../../stores/dockStore';
import { mapSubAgentStatus, subAgentHasResponded } from '../panels/subagentUtils';
import { SubAgentConversation } from '../panels/SubAgentConversation';
import type { DockBodyProps } from './TabBodyRenderer';

/**
 * registry 后端子代理的兜底会话视图（跨会话 / 后台 spawn）。
 *
 * 原先自行轮询 subagentList（全量 50 行 + transcript），现在：
 * - 状态来自 subagentLiveStore 单例（轻量、无 transcript）
 * - transcript 由 SubAgentConversation 通过 subagentGetTranscript 按需拉取
 * 本组件只负责把 workspace / agentId / status 传下去即可。
 */
export function SubAgentLogBody({ tab }: DockBodyProps) {
  const payload = tab.payload as SubAgentLogPayload;
  const workspace = useOptionalAgentStoreContext()?.workspace ?? '';
  const startPolling = useSubAgentLiveStore((s) => s.startPolling);

  const ownerPath = tab.ownerSessionPath ?? '';
  const observation = useSubAgentLiveStore(selectSubAgentObservation(workspace, ownerPath, payload.agentId));
  const listItem = useSubAgentLiveStore(selectSubAgentById(workspace, payload.agentId));
  const liveItem = ownerPath ? observation.item : listItem;

  // payload 的明确终态是水位：旧 running 快照不得重新打开轮询。
  const [initStatus] = useState(() => payload.status);
  const liveStatus = liveItem ? mapSubAgentStatus(liveItem.status, liveItem.error) : null;
  const status: 'running' | 'done' | 'error' =
    initStatus !== 'running' && liveStatus === 'running' ? initStatus : liveStatus ?? initStatus;
  const output = liveItem?.output ?? payload.output ?? '';

  // 在运行中时启动轮询（store 引用计数，多个消费者共享一个 interval）
  const watch = useSubAgentLiveStore((s) => s.watch);
  useEffect(() => {
    if (!workspace || status !== 'running') return;
    return ownerPath ? watch(workspace, ownerPath, payload.agentId) : startPolling(workspace);
  }, [workspace, ownerPath, payload.agentId, status, watch, startPolling]);

  // 用 result 形状包装 output（无 transcript 时的纯文本兜底）
  const result = output
    ? { content: [{ type: 'text', text: output }] }
    : undefined;

  return (
    <SubAgentConversation
      key={tab.id}
      data-testid={`subagent-log-${payload.agentId}`}
      task={payload.task}
      result={result}
      status={status}
      workspace={workspace}
      agentId={payload.agentId}
      parentSessionPath={ownerPath}
      phase={status !== 'running' ? status
        : subAgentObservationUnconfirmed(observation) ? 'status-unconfirmed'
          : !subAgentHasResponded(liveItem) ? liveItem?.status === 'running' ? 'awaiting-first-response' : 'starting' : 'running'}
    />
  );
}
