import { useMemo } from 'react';
import { type ChatMessage, messagesFromTranscript } from '../../stores/agentReducer';
import { useThrottledValue } from '../../hooks/useThrottledValue';
import { groupMessages } from '../chat/groupMessages';
import { ChatMessageItems } from '../chat/ChatMessageItems';
import { computeSubAgentUnits, computeAnsweredQuestions } from '../chat/messagePrecompute';

/** 从 spawn_agent 工具结果里取原始 JSONL transcript（details.transcript）。 */
function transcriptOf(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== 'object') return '';
  const d = details as { transcript?: unknown; transcriptTail?: unknown };
  // 终态有完整 transcript；运行中后端只推尾部 transcriptTail（防 O(n^2) 串卡爆前端）。
  if (typeof d.transcript === 'string' && d.transcript) return d.transcript;
  return typeof d.transcriptTail === 'string' ? d.transcriptTail : '';
}

/** transcript 缺失时（如多任务/旧数据）的兜底：取结果文本块。 */
function fallbackText(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (b): b is { type: string; text: string } =>
        !!b && typeof b === 'object' && (b as { type?: string }).type === 'text',
    )
    .map((b) => b.text)
    .join('');
}

interface SubAgentConversationProps {
  task: string;
  result: unknown;
  status: 'running' | 'done' | 'error';
  'data-testid'?: string;
}

/** 单个子代理的对话视图：把子代理 JSONL 还原成消息，用主对话同款气泡 + 虚拟化渲染。 */
export function SubAgentConversation({ task, result, status, 'data-testid': testId }: SubAgentConversationProps) {
  // 运行中 result（transcript）每帧增长，100ms 节流避免每个 token 都重解析整段 JSONL（与主对话同口径）。
  const liveResult = useThrottledValue(result, 100, { enabled: status === 'running' });
  const messages = useMemo<ChatMessage[]>(() => {
    const out: ChatMessage[] = [{ kind: 'user', id: 'sa-task', text: task }];
    const transcript = transcriptOf(liveResult);
    if (transcript) {
      out.push(...messagesFromTranscript(transcript));
    } else {
      const text = fallbackText(liveResult);
      if (text) out.push({ kind: 'assistant', id: 'sa-out', text, thinking: '', streaming: status === 'running' });
    }
    return out;
  }, [task, liveResult, status]);

  const display = useMemo(() => groupMessages(messages), [messages]);
  const unitsByMessage = useMemo(() => computeSubAgentUnits(display), [display]);
  const answeredQuestions = useMemo(() => computeAnsweredQuestions(display), [display]);

  return (
    <ChatMessageItems
      messages={display}
      unitsByMessage={unitsByMessage}
      answeredQuestions={answeredQuestions}
      paddingInline={16}
      data-testid={testId}
    />
  );
}
