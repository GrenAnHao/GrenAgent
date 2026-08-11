import { useEffect, useState } from 'react';
import { useSubAgentLiveStore, selectSubAgentById } from '../../stores/subagentLiveStore';
import { useOptionalAgentStoreContext } from '../../stores/AgentStoreContext';
import type { SubAgentLogPayload } from '../../stores/dockStore';
import { mapSubAgentStatus } from '../panels/subagentUtils';
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

  // 用 subagentLiveStore 获取最新状态（轻量，无 transcript）
  const liveItem = useSubAgentLiveStore(
    selectSubAgentById(workspace, payload.agentId),
  );

  // 初始状态来自 payload 快照；一旦 store 有数据就用 store 的
  const [initStatus] = useState(() => payload.status);
  const status: 'running' | 'done' | 'error' =
    liveItem ? mapSubAgentStatus(liveItem.status) : initStatus;
  const output = liveItem?.output ?? payload.output ?? '';

  // 在运行中时启动轮询（store 引用计数，多个消费者共享一个 interval）
  useEffect(() => {
    if (!workspace || status !== 'running') return;
    return startPolling(workspace);
  }, [workspace, status, startPolling]);

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
    />
  );
}
