import { useMemo } from 'react';
import { useAgentStore, useAgentStoreContext } from '../../stores/AgentStoreContext';
import { useSessionStore } from '../../store/session';
import { useCommandInputStore } from '../../stores/commandInputStore';
import { useUiPromptStore } from '../../stores/uiPromptStore';
import { useThrottledValue } from '../../hooks/useThrottledValue';
import { groupMessages, mergeCommandInputs, type CommandInputMessage } from './groupMessages';
import { ChatMessageItems } from './ChatMessageItems';
import { ChatMiniMap } from '../ChatMiniMap';
import { computeSubAgentUnits, computeAnsweredQuestions } from './messagePrecompute';
import { PreparingIndicator } from './PreparingIndicator';
import { PromptPendingRow } from './PromptPendingRow';
import { shouldRenderUiPromptInOverlay } from './input/overlayPrompt';
import { waitingUiPromptLabel } from '../../stores/waitingUiPrompt';

const EMPTY_COMMAND_INPUTS: CommandInputMessage[] = [];

export function ChatListView() {
  const { workspace } = useAgentStoreContext();
  const { useStore } = useAgentStore();
  const uiPrompt = useUiPromptStore((s) => s.byWorkspace[workspace]);
  const overlayPending = Boolean(uiPrompt && shouldRenderUiPromptInOverlay(uiPrompt.request));
  // 当前会话 path 作为列表 resetKey：切换会话时重置滚动锚点并贴底（修复首次不贴底 / 切换抖动）。
  const sessionPath = useSessionStore((s) => s.activeSessionPath);
  const commandInputs = useCommandInputStore((s) =>
    sessionPath ? (s.bySession[sessionPath] ?? EMPTY_COMMAND_INPUTS) : EMPTY_COMMAND_INPUTS,
  );
  const messages = useStore((s) => s.messages);
  const isStreaming = useStore((s) => s.isStreaming);
  const awaitingResponse = useStore((s) => s.awaitingResponse);
  const waitingLabel = waitingUiPromptLabel(useStore((s) => s.waitingUiPrompt));

  // streaming 中 100ms 节流，避免每 token 触发整列重算（详见 useThrottledValue 契约）。
  const throttledMessages = useThrottledValue(messages, 100, { enabled: isStreaming });
  // command-input 不进 groupMessages。按发送时的 beforeCount 插回，对齐 DSH 的 command/run seq。
  // 准备态只看 grouped 末项：本地 /goal 行不能据此判断「有没有助手 turn」。
  const grouped = useMemo(() => groupMessages(throttledMessages), [throttledMessages]);
  const display = useMemo(
    () => (sessionPath ? mergeCommandInputs(grouped, commandInputs) : grouped),
    [grouped, sessionPath, commandInputs],
  );
  const unitsByMessage = useMemo(() => computeSubAgentUnits(display), [display]);
  const answeredQuestions = useMemo(() => computeAnsweredQuestions(display), [display]);

  const last = grouped[grouped.length - 1];
  const lastIsSteer = last?.kind === 'user' && last.steering === true;
  const showDefaultPreparing =
    (isStreaming || Boolean(awaitingResponse)) &&
    !lastIsSteer &&
    (!last || (last.kind !== 'turn' && last.kind !== 'tool'));

  const footer = waitingLabel ? (
    <PreparingIndicator label={waitingLabel} />
  ) : overlayPending ? (
    <PromptPendingRow data-testid="ui-prompt-pending" label="等待你选择" live />
  ) : showDefaultPreparing ? (
    <PreparingIndicator />
  ) : undefined;

  return (
    <ChatMessageItems
      messages={display}
      unitsByMessage={unitsByMessage}
      answeredQuestions={answeredQuestions}
      footer={footer}
      overlay={(viewport) => <ChatMiniMap messages={display} viewport={viewport} />}
      fill="absolute"
      paddingInline={24}
      resetKey={sessionPath}
      data-testid="chat-scroll"
    />
  );
}
