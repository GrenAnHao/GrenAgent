import { useEffect, useMemo, useRef } from 'react';
import { createStaticStyles } from 'antd-style';
import { useAgentStore } from '../../stores/AgentStoreContext';
import { useThrottledValue } from '../../hooks/useThrottledValue';
import { groupMessages } from './groupMessages';
import { ChatMessageItems } from './ChatMessageItems';
import { PreparingIndicator } from './PreparingIndicator';

const styles = createStaticStyles(({ css }) => ({
  scroll: css`
    position: absolute;
    inset: 0;
    overflow-y: auto;
  `,
  list: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 16px 24px;
  `,
}));

export function ChatListView() {
  const { useStore } = useAgentStore();
  const messages = useStore((s) => s.messages);
  const isStreaming = useStore((s) => s.isStreaming);

  // streaming 中 100ms 节流，避免每 token 触发整列重算（详见 useThrottledValue 契约）。
  const throttledMessages = useThrottledValue(messages, 100, { enabled: isStreaming });
  const display = useMemo(() => groupMessages(throttledMessages), [throttledMessages]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 120;
  };

  // 新内容到达后，仅当用户停留在底部时跟随滚底（对齐 SubAgentConversation 的 atBottom 模式）。
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  });

  // 等待占位（对齐 lobehub 的「准备响应中…」）：仅在「还没有助手槽」时用独立占位
  //（如刚发完用户消息、助手组尚未建立）。一旦存在助手组(assistantGroup)，由 AssistantMessage
  // 在槽内显示「准备中」，使首字到达时原地替换、不产生抖动。tool 运行中不显示。
  const last = display[display.length - 1];
  const showPreparing =
    isStreaming && (!last || (last.kind !== 'assistantGroup' && last.kind !== 'tool'));

  return (
    <div
      ref={scrollRef}
      className={styles.scroll}
      onScroll={handleScroll}
      data-testid="chat-scroll"
    >
      <div className={styles.list}>
        <ChatMessageItems messages={display} />
        {showPreparing ? <PreparingIndicator /> : null}
      </div>
    </div>
  );
}
