import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
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
  const listRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 120;
  };

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, []);

  // 新内容到达后，仅当用户停留在底部时跟随滚底。用 layoutEffect 在绘制前完成，
  // 避免「先按旧位置绘制、再跳到底部」的抽搐（对齐 SubAgentConversation 的 atBottom 模式）。
  useLayoutEffect(() => {
    scrollToBottom();
  });

  // 流式打字机会在两次渲染之间持续撑高内容；用 ResizeObserver 跟随高度变化平滑贴底，
  // 避免只在每次节流渲染时阶梯式跳动。
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const ro = new ResizeObserver(() => scrollToBottom());
    ro.observe(list);
    return () => ro.disconnect();
  }, [scrollToBottom]);

  // 等待占位：仅在「还没有助手 turn」时用独立占位。一旦存在 turn，由 TurnTimeline
  // 在槽内显示「准备中」。tool / spawn_agent 运行中不显示。
  const last = display[display.length - 1];
  const lastIsSteer = last?.kind === 'user' && last.steering === true;
  const showPreparing =
    isStreaming &&
    !lastIsSteer &&
    (!last || (last.kind !== 'turn' && last.kind !== 'tool'));

  return (
    <div
      ref={scrollRef}
      className={styles.scroll}
      onScroll={handleScroll}
      data-testid="chat-scroll"
    >
      <div ref={listRef} className={styles.list}>
        <ChatMessageItems messages={display} lazy />
        {showPreparing ? <PreparingIndicator /> : null}
      </div>
    </div>
  );
}
