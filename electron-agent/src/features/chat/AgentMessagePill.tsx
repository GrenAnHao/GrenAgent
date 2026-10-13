import { MailOpen } from 'lucide-react';
import { memo } from 'react';
import { NoticeSplitPill } from './NoticeSplitPill';

const HEAD = /^Agent (\S+) sent a message without waking you:\s*([\s\S]*)$/;

/**
 * send_message wake: false 的消息（extensions/multi-agent/activation.ts agentMessage）：
 * 首行是写给模型的英文，界面上换成「来自 sa-1 的消息（未唤醒）」，展开看正文。
 * 父会话和子代理的对话里都会出现：父→子写进子会话，子→父写进父会话。
 */
export function agentMessageTitle(firstLine: string): string {
  const match = HEAD.exec(firstLine.trim());
  if (!match) return firstLine;
  return `来自 ${match[1]} 的消息（未唤醒）`;
}

function AgentMessagePillInner({ content }: { content: string }) {
  return <NoticeSplitPill content={content} icon={MailOpen} testId="agent-message-pill" formatTitle={agentMessageTitle} />;
}

export const AgentMessagePill = memo(AgentMessagePillInner);
