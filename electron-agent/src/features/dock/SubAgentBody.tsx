import { useAgentStore } from '../../stores/AgentStoreContext';
import type { ChatMessage } from '../../stores/agentReducer';
import { useLayoutStore, selectRightPanelVisible } from '../../stores/layoutStore';
import { SubAgentConversation } from '../panels/SubAgentConversation';
import { subAgentUnitView } from '../panels/subagentUtils';
import type { SubAgentPayload } from '../../stores/dockStore';
import type { DockBodyProps } from './TabBodyRenderer';

type ToolMessage = Extract<ChatMessage, { kind: 'tool' }>;

export function SubAgentBody({ tab, active }: DockBodyProps) {
  const payload = tab.payload as SubAgentPayload;
  const panelOpen = useLayoutStore(selectRightPanelVisible);
  const store = useAgentStore();
  const sa = store.useStore(
    (s) => s.messages.find((m) => m.kind === 'tool' && m.id === payload.messageId) as ToolMessage | undefined,
  );
  // 仅在右侧面板打开且本 tab 处于激活态时才渲染会话：
  // dock body 是 keep-alive 常驻挂载的，折叠/非激活时若仍渲染，流式中会每帧解析 transcript 造成卡顿。
  if (!sa || !active || !panelOpen) return null;
  // 单任务 → 复用整条消息（含完整 transcript）；并行/链式 → 取对应子代理的最终输出。
  const view = subAgentUnitView(sa.args, sa.result, sa.status, payload.subIndex ?? null);
  return (
    <SubAgentConversation
      key={tab.id}
      data-testid={`subagent-${payload.toolCallId}`}
      task={view.task}
      result={view.result}
      status={view.status}
    />
  );
}
