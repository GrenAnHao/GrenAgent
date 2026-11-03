import { memo } from 'react';
import { AgentCommunicationCard, useAgentIdentity } from './AgentCommunicationCard';
import { incomingAgentMessage } from './agentCommunicationModel';

export function agentMessageTitle(firstLine: string): string {
  const parsed = incomingAgentMessage(firstLine.trim());
  return parsed ? `来自 ${parsed.sender} 的消息${parsed.quiet ? '（未唤醒）' : ''}` : firstLine;
}

function AgentMessagePillInner({ content, details, timestamp }: { content: string; details?: unknown; timestamp?: number }) {
  const text = typeof content === 'string' ? content : '';
  const parsed = incomingAgentMessage(text);
  const from = details && typeof details === 'object' ? (details as { from?: unknown }).from : undefined;
  const sender = typeof from === 'string' && from.trim() ? from.trim() : parsed?.sender || '发送方未记录';
  const recipient = useAgentIdentity();
  return (
    <AgentCommunicationCard
      testId="agent-message-pill"
      sender={sender}
      recipient={recipient}
      body={parsed?.body ?? text}
      state={parsed?.quiet ? '已接收 · 未唤醒' : '已接收'}
      timestamp={timestamp}
    />
  );
}

export const AgentMessagePill = memo(AgentMessagePillInner);
