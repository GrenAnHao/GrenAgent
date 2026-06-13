import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ActionIcon } from '@lobehub/ui';
import { createStaticStyles, cx } from 'antd-style';
import { ArrowDown } from 'lucide-react';
import { useAgentStore } from '../../stores/AgentStoreContext';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { PreparingIndicator } from './PreparingIndicator';
import { NoticePill } from './NoticePill';

const ToolExecution = lazy(() =>
  import('../tools/ToolExecution').then((m) => ({ default: m.ToolExecution })),
);

/** Distance (px) from the bottom within which the list is still treated as "at bottom". */
const AT_BOTTOM_THRESHOLD = 300;

const styles = createStaticStyles(({ css }) => ({
  backBottom: css`
    position: absolute;
    inset-inline-end: 16px;
    z-index: 30;

    opacity: 0;
    transform: translateY(8px);
    pointer-events: none;

    transition:
      opacity 0.2s ease,
      transform 0.2s ease;
  `,
  backBottomVisible: css`
    transform: translateY(0);
    opacity: 1;
    pointer-events: auto;
  `,
}));

interface MessageListProps {
  bottomOffset?: number;
}

export function MessageList({ bottomOffset = 88 }: MessageListProps) {
  const { useStore } = useAgentStore();
  const messages = useStore((s) => s.messages);
  const isStreaming = useStore((s) => s.isStreaming);

  // agent_start 后、首条助手输出前的等待窗口：尾部既不是正在流式的助手气泡，
  // 也不是运行中的工具时，显示「准备响应中…」占位（pi 的 agent_start/agent_end 驱动）。
  const tail = messages[messages.length - 1];
  const tailBusy =
    !!tail &&
    ((tail.kind === 'assistant' && tail.streaming) ||
      (tail.kind === 'tool' && tail.status === 'running'));
  const showPreparing = isStreaming && !tailBusy;

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const next = distance <= AT_BOTTOM_THRESHOLD;
    atBottomRef.current = next;
    setAtBottom((prev) => (prev === next ? prev : next));
  }, []);

  // Stick to bottom while new content streams in, but only when the user is already near
  // the bottom. Observing the content box catches text growth, markdown reflow and async
  // image/layout changes that a plain scroll listener would miss.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (atBottomRef.current) scrollToBottom('auto');
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollToBottom]);

  return (
    <>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{
          position: 'absolute',
          top: 0,
          bottom: bottomOffset,
          left: 0,
          right: 0,
          overflowY: 'auto',
        }}
      >
        <div
          ref={contentRef}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
            padding: '1rem',
          }}
        >
          {messages.map((msg) => {
            switch (msg.kind) {
              case 'user':
                return <UserMessage key={msg.id} text={msg.text} />;
              case 'assistant':
                return (
                  <AssistantMessage
                    key={msg.id}
                    text={msg.text}
                    thinking={msg.thinking}
                    streaming={msg.streaming}
                    thinkingDuration={msg.thinkingDuration}
                  />
                );
              case 'tool':
                return (
                  <Suspense key={msg.id} fallback={null}>
                    <ToolExecution
                      toolName={msg.toolName}
                      args={msg.args}
                      result={msg.result}
                      status={msg.status}
                    />
                  </Suspense>
                );
              case 'notice':
                return <NoticePill key={msg.id} customType={msg.customType} content={msg.content} />;
              default:
                return null;
            }
          })}
          {showPreparing && <PreparingIndicator />}
        </div>
      </div>
      <ActionIcon
        title="回到底部"
        glass
        variant="filled"
        icon={ArrowDown}
        className={cx(styles.backBottom, !atBottom && styles.backBottomVisible)}
        style={{ insetBlockEnd: bottomOffset + 16 }}
        onClick={() => scrollToBottom('smooth')}
      />
    </>
  );
}
