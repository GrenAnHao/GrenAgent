import { useMemo } from 'react';
import { useAgentStore } from '../../stores/AgentStoreContext';
import { useSessionStore } from '../../store/session';
import { useThrottledValue } from '../../hooks/useThrottledValue';
import { groupMessages } from './groupMessages';
import { ChatMessageItems } from './ChatMessageItems';
import { computeSubAgentUnits, computeAnsweredQuestions } from './messagePrecompute';
import { PreparingIndicator } from './PreparingIndicator';

export function ChatListView() {
  const { useStore } = useAgentStore();
  // 当前会话 path 作为列表 resetKey：切换会话时重置滚动锚点并贴底（修复首次不贴底 / 切换抖动）。
  const sessionPath = useSessionStore((s) => s.activeSessionPath);
  const messages = useStore((s) => s.messages);
  const isStreaming = useStore((s) => s.isStreaming);
  const awaitingResponse = useStore((s) => s.awaitingResponse);

  // streaming 中 100ms 节流，避免每 token 触发整列重算（详见 useThrottledValue 契约）。
  const throttledMessages = useThrottledValue(messages, 100, { enabled: isStreaming });
  const display = useMemo(() => groupMessages(throttledMessages), [throttledMessages]);
  const unitsByMessage = useMemo(() => computeSubAgentUnits(display), [display]);
  const answeredQuestions = useMemo(() => computeAnsweredQuestions(display), [display]);

  // 等待占位：仅在「还没有助手 turn」时用独立占位。一旦存在 turn/tool，由其它组件接管。
  const last = display[display.length - 1];
  const lastIsSteer = last?.kind === 'user' && last.steering === true;
  const showPreparing =
    (isStreaming || Boolean(awaitingResponse)) &&
    !lastIsSteer &&
    (!last || (last.kind !== 'turn' && last.kind !== 'tool'));

  return (
    <ChatMessageItems
      messages={display}
      unitsByMessage={unitsByMessage}
      answeredQuestions={answeredQuestions}
      footer={showPreparing ? <PreparingIndicator /> : undefined}
      fill="absolute"
      paddingInline={24}
      resetKey={sessionPath}
      data-testid="chat-scroll"
    />
  );
}
