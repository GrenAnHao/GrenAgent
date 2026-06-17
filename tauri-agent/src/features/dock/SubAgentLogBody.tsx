import { SubAgentConversation } from '../panels/SubAgentConversation';
import type { SubAgentLogPayload } from '../../stores/dockStore';
import type { DockBodyProps } from './TabBodyRenderer';

/**
 * registry 后端子代理的兜底会话视图：当浮动列表点击的子代理在当前主对话里
 * 找不到对应 spawn_agent 消息（跨会话 / 后台 spawn）时使用。registry 仅存最终
 * output 文本（无完整 JSONL transcript），故只还原任务 + 输出两条消息。
 */
export function SubAgentLogBody({ tab }: DockBodyProps) {
  const payload = tab.payload as SubAgentLogPayload;
  const result = { content: [{ type: 'text', text: payload.output || '(暂无输出)' }] };
  return (
    <SubAgentConversation
      key={tab.id}
      data-testid={`subagent-log-${payload.agentId}`}
      task={payload.task}
      result={result}
      status={payload.status}
    />
  );
}
