import { AgentCommunicationCard, useAgentIdentity } from '../chat/AgentCommunicationCard';
import { outgoingAgentMessage } from '../chat/agentCommunicationModel';
import type { ConvStatus } from '../chat/conv/StatusGlyph';
import { RunDuration } from './RunDuration';

export function SendMessageCard({ args, result, status, argsComplete, startedAt, durationMs, preview }: {
  args: unknown;
  result: unknown;
  status: ConvStatus;
  argsComplete?: boolean;
  startedAt?: number;
  durationMs?: number;
  /** The upstream codemode history contains a bounded JSON preview rather than full tool arguments. */
  preview?: string;
}) {
  const sender = useAgentIdentity();
  const view = outgoingAgentMessage(args, result, status, argsComplete);
  return (
    <AgentCommunicationCard
      testId="send-message-card"
      sender={sender}
      recipient={view.recipient || '接收方未记录'}
      body={view.body || preview || ''}
      state={view.state}
      status={view.status}
      timestamp={startedAt}
      meta={<>{view.policy}<RunDuration startedAt={startedAt} durationMs={durationMs} running={status === 'running'} /></>}
      note={[view.note, preview ? '历史仅保留参数预览，消息正文可能不完整；此记录未保存投递回执。' : ''].filter(Boolean).join('\n')}
    />
  );
}
