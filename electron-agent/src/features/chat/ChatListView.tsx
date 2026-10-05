import { useMemo, type Ref } from 'react';
import { useAgentStore, useAgentStoreContext } from '../../stores/AgentStoreContext';
import { useSessionStore } from '../../store/session';
import { useCommandInputStore } from '../../stores/commandInputStore';
import { useUiPromptStore } from '../../stores/uiPromptStore';
import { useThrottledValue } from '../../hooks/useThrottledValue';
import { groupMessages, type CommandInputMessage } from './groupMessages';
import { ChatMessageItems } from './ChatMessageItems';
import { ChatMiniMap } from '../ChatMiniMap';
import { computeSubAgentUnits, computeAnsweredQuestions } from './messagePrecompute';
import { PreparingIndicator } from './PreparingIndicator';
import { PendingResponseStatus } from './PendingResponseStatus';
import { CompactionDivider } from './CompactionStatusRow';
import { PromptPendingRow } from './PromptPendingRow';
import { shouldRenderUiPromptInOverlay } from './input/overlayPrompt';
import { waitingUiPromptLabel } from '../../stores/waitingUiPrompt';
import type { TranscriptScrollHandle } from './VirtualizedMessageList';

const EMPTY_COMMAND_INPUTS: CommandInputMessage[] = [];

interface ChatListViewProps {
  paddingBottom?: number;
  scrollRef?: Ref<TranscriptScrollHandle>;
  onGutterChange?: (px: number) => void;
}

export function ChatListView({ paddingBottom, scrollRef, onGutterChange }: ChatListViewProps) {
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
  const retrying = useStore((s) => s.retrying);
  const runActive = useStore((s) => s.runActive);
  const compacting = useStore((s) => s.compacting);
  const waitingLabel = waitingUiPromptLabel(useStore((s) => s.waitingUiPrompt));
  const sessionLive = isStreaming || Boolean(awaitingResponse) || Boolean(retrying) || Boolean(runActive) || Boolean(compacting);

  // streaming 中 100ms 节流，避免每 token 触发整列重算（详见 useThrottledValue 契约）。
  const throttledMessages = useThrottledValue(messages, 100, { enabled: isStreaming });
  // command-input 不进 groupMessages（输入仍是 ChatMessage[]），按当前会话 path 拼在分组后。
  // 准备态只看 grouped 末项：本地 /goal 行永远在 display 末尾，不能据此判断「有没有助手 turn」。
  const grouped = useMemo(() => groupMessages(throttledMessages), [throttledMessages]);
  const display = useMemo(
    () => (sessionPath ? [...grouped, ...commandInputs] : grouped),
    [grouped, sessionPath, commandInputs],
  );
  const subAgents = useMemo(() => computeSubAgentUnits(display), [display]);
  const answeredQuestions = useMemo(() => computeAnsweredQuestions(display), [display]);

  const runStartedAt = useStore((s) => s.runStartedAt);
  const sessionBusy = isStreaming || Boolean(awaitingResponse) || Boolean(runActive);

  const footer = compacting ? (
    <CompactionDivider label="正在压缩" live testId="compaction-indicator" />
  ) : waitingLabel ? (
    <PreparingIndicator label={waitingLabel} />
  ) : overlayPending ? (
    <PromptPendingRow data-testid="ui-prompt-pending" label="等待你选择" live />
  ) : sessionBusy ? (
    <PendingResponseStatus label="正在处理…" startedAt={runStartedAt} />
  ) : undefined;

  return (
    <ChatMessageItems
      messages={display}
      unitsByMessage={subAgents.unitsByMessage}
      hiddenSpawnIds={subAgents.hidden}
      spawnOverlay={subAgents.overlay}
      answeredQuestions={answeredQuestions}
      footer={footer}
      overlay={(viewport) => <ChatMiniMap messages={display} viewport={viewport} />}
      fill="absolute"
      paddingInline={24}
      resetKey={sessionPath}
      paddingBottom={paddingBottom}
      scrollRef={scrollRef}
      onGutterChange={onGutterChange}
      data-testid="chat-scroll"
      showDeliverables
      sessionLive={sessionLive}
    />
  );
}
