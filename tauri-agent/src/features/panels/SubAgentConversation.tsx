import { useEffect, useMemo, useRef } from 'react';
import { createStaticStyles } from 'antd-style';
import { type ChatMessage, messagesFromTranscript } from '../../stores/agentReducer';
import { useThrottledValue } from '../../hooks/useThrottledValue';
import { groupMessages } from '../chat/groupMessages';
import { ChatMessageItems } from '../chat/ChatMessageItems';

const styles = createStaticStyles(({ css }) => ({
  scroll: css`
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  `,
  list: css`
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 1rem;
  `,
}));

/** 从 spawn_agent 工具结果里取原始 JSONL transcript（details.transcript）。 */
function transcriptOf(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== 'object') return '';
  const t = (details as { transcript?: unknown }).transcript;
  return typeof t === 'string' ? t : '';
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

/** 单个子代理的对话视图：把子代理 JSONL 还原成消息，用主对话同款气泡渲染。 */
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

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 120;
  };
  // 流式增长时若用户停在底部则跟随滚动；用户上滑后不打扰。
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <div ref={scrollRef} className={styles.scroll} onScroll={handleScroll} data-testid={testId}>
      <div className={styles.list}>
        <ChatMessageItems messages={display} />
      </div>
    </div>
  );
}
