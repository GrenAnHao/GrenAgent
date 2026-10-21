import { useMemo, type ReactNode, type Ref } from 'react';
import { createStaticStyles, cssVar } from 'antd-style';
import type { DisplayMessage } from './groupMessages';
import { UserMessage } from './UserMessage';
import { TurnTimeline, TurnTimelineRow } from './TurnTimeline';
import { buildTurnRows, type TurnRow } from './turnRows';
import { NoticePill } from './NoticePill';
import { SubagentSettledPill } from './SubagentSettledPill';
import { JobDonePill } from './JobDonePill';
import { AgentMessagePill } from './AgentMessagePill';
import { GoalRoundPill } from './GoalRoundPill';
import { UiPromptReceipt } from './UiPromptReceipt';
import { AnswerCard } from './AnswerCard';
import { PlanCard } from './PlanCard';
import { QuestionsCard } from './QuestionsCard';
import { VisualCard } from '../visual/VisualCard';
import { VirtualizedMessageList, type MessageListViewport, type TranscriptScrollHandle } from './VirtualizedMessageList';
import { ToolExecution } from '../tools/ToolExecution';
import { SubAgentInline } from './SubAgentInline';
import { SubAgentGroupInline, type NumberedUnit } from './SubAgentGroupInline';
import { argsLookParallel, subAgentMode, taskLabel } from '../panels/subagentUtils';
import type { SpawnFollowOverlay } from './messagePrecompute';
import { ChatTagView } from './input/editor/ChatTag/ChatTagView';
import { CompactionDivider } from './CompactionStatusRow';

const commandInputStyles = createStaticStyles(({ css }) => ({
  row: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: flex-end;
    padding-inline-start: 36px;
    font-size: 14px;
    line-height: 1.6;
    color: ${cssVar.colorText};
  `,
}));

const EMPTY_HIDDEN = new Set<string>();
const EMPTY_OVERLAY = new Map<string, SpawnFollowOverlay>();

interface ChatMessageItemsProps {
  messages: DisplayMessage[];
  /** 全局预计算（由调用方 useMemo 缓存后传入）。 */
  unitsByMessage: Map<string, NumberedUnit[]>;
  /** 并回启动卡片的跟进调用，不单独占一行。 */
  hiddenSpawnIds?: Set<string>;
  /** 启动卡片改显示跟进结果（等待完成之后）。 */
  spawnOverlay?: Map<string, SpawnFollowOverlay>;
  answeredQuestions: Set<string>;
  /** 列表末尾附加元素（如「准备响应中」占位）。 */
  footer?: ReactNode;
  /** 覆盖在列表之上的浮层（如 ChatMiniMap），透传给 VirtualizedMessageList。 */
  overlay?: (viewport: MessageListViewport) => ReactNode;
  /** 填充方式：主对话父容器 position:relative → 'absolute'；子代理面板 flex 子项 → 'flex'（默认）。 */
  fill?: 'absolute' | 'flex';
  /** 每条消息左右内边距（主对话 24，子代理 16）。 */
  paddingInline?: number;
  /** 会话 / 对话标识：变化时列表重置滚动锚点并贴底（透传给 VirtualizedMessageList）。 */
  resetKey?: string | null;
  paddingBottom?: number;
  scrollRef?: Ref<TranscriptScrollHandle>;
  onGutterChange?: (px: number) => void;
  'data-testid'?: string;
  showDeliverables?: boolean;
  /** 当前会话仍在跑（流式 / 等首包 / 重试）。仅压住仍挂在列表末尾的那一轮。 */
  sessionLive?: boolean;
  /** 子代理通常只有一轮：把这轮的渲染行分别交给共享虚拟列表，避免整轮工具全挂载。 */
  virtualizeTurnRows?: boolean;
}

type TurnRowMessage = { kind: 'turn-row'; id: string; row: TurnRow; first: boolean; last: boolean; actionText?: string };

/** 会话仍在跑时，压住当前这一轮。通知 / spawn_agent / 引导消息不把上一截当成已结束。 */
export function liveTurnId(messages: DisplayMessage[], sessionLive: boolean): string | undefined {
  if (!sessionLive) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i];
    if (item.kind === 'command-input') continue;
    if (item.kind === 'user' && !item.steering) return undefined;
    if (item.kind === 'turn') return item.id;
  }
  return undefined;
}

/** 单条消息渲染器：user/assistant(turn)/tool/notice 分发；主对话与子代理对话共用。 */
export function renderMessageBody(
  msg: DisplayMessage,
  unitsByMessage: Map<string, NumberedUnit[]>,
  answeredQuestions: Set<string>,
  showDeliverables = false,
  liveTurn = false,
  spawnOverlay: Map<string, SpawnFollowOverlay> = EMPTY_OVERLAY,
): ReactNode {
  switch (msg.kind) {
    case 'user':
      return (
        <UserMessage
          id={msg.id}
          text={msg.text}
          images={msg.images}
          timestamp={msg.timestamp}
          entryId={msg.entryId}
          steering={msg.steering}
          steerState={msg.steerState}
          promptFrame={msg.promptFrame}
        />
      );
    case 'turn':
      return (
        <TurnTimeline
          segments={msg.segments}
          timestamp={msg.timestamp}
          turnId={msg.id}
          showDeliverables={showDeliverables}
          live={liveTurn}
        />
      );
    case 'tool':
      if (msg.toolName === 'spawn_agent') {
        const numbered = unitsByMessage.get(msg.id) ?? [];
        if (numbered.length <= 1 && !argsLookParallel(msg.args)) {
          const only = numbered[0];
          const followed = spawnOverlay.get(msg.id);
          return (
            <SubAgentInline
              messageId={msg.id}
              toolCallId={msg.toolCallId}
              index={only?.no ?? 1}
              task={only?.unit.task ?? taskLabel(msg.args)}
              title={only?.unit.title}
              model={only?.unit.model}
              thinkingLevel={only?.unit.thinkingLevel}
              result={followed?.result ?? msg.result}
              status={followed?.status ?? msg.status}
            />
          );
        }
        return (
          <SubAgentGroupInline
            messageId={msg.id}
            toolCallId={msg.toolCallId}
            mode={subAgentMode(msg.args)}
            status={msg.status}
            units={numbered}
          />
        );
      }
      return (
        <ToolExecution
          toolName={msg.toolName}
          toolCallId={msg.toolCallId}
          args={msg.args}
          result={msg.result}
          status={msg.status}
          argsComplete={msg.argsComplete}
          startedAt={msg.startedAt}
          durationMs={msg.durationMs}
        />
      );
    case 'compaction':
      return <CompactionDivider label="已压缩" testId="compaction-done" />;
    case 'notice':
      if (msg.customType === 'agent-answer') return <AnswerCard content={msg.content} />;
      if (msg.customType === 'agent-plan') return <PlanCard content={msg.content} />;
      if (msg.customType === 'agent-questions') {
        return <QuestionsCard answered={answeredQuestions.has(msg.id)} content={msg.content} />;
      }
      if (msg.customType === 'visual-inline') return <VisualCard content={msg.content} />;
      if (msg.customType === 'subagent-settled') return <SubagentSettledPill content={msg.content} />;
      if (msg.customType === 'job-done') return <JobDonePill content={msg.content} />;
      if (msg.customType === 'agent-message') return <AgentMessagePill content={msg.content} />;
      if (msg.customType === 'goal-round') return <GoalRoundPill content={msg.content} />;
      if (msg.customType === 'ui-prompt-receipt') return <UiPromptReceipt content={msg.content} />;
      return <NoticePill customType={msg.customType} content={msg.content} />;
    case 'command-input':
      return (
        <div data-testid="command-input" className={commandInputStyles.row}>
          <ChatTagView
            category="command"
            label={msg.command}
            value={msg.command.replace(/^\//, '')}
          />
          {msg.rest ? <span>{msg.rest}</span> : null}
        </div>
      );
    default:
      return null;
  }
}

/** 共享的对话气泡渲染：主对话与子代理对话复用同一套虚拟化 + 气泡组件。 */
export function ChatMessageItems({
  messages,
  unitsByMessage,
  hiddenSpawnIds = EMPTY_HIDDEN,
  spawnOverlay = EMPTY_OVERLAY,
  answeredQuestions,
  footer,
  overlay,
  fill,
  paddingInline,
  resetKey,
  paddingBottom,
  scrollRef,
  onGutterChange,
  'data-testid': testId,
  showDeliverables,
  sessionLive,
  virtualizeTurnRows = false,
}: ChatMessageItemsProps) {
  const liveId = liveTurnId(messages, Boolean(sessionLive));
  const visible = useMemo(
    () => (hiddenSpawnIds.size === 0 ? messages : messages.filter((msg) => !hiddenSpawnIds.has(msg.id))),
    [messages, hiddenSpawnIds],
  );
  const items = useMemo<(DisplayMessage | TurnRowMessage)[]>(() => {
    if (!virtualizeTurnRows) return visible;
    return visible.flatMap((msg): (DisplayMessage | TurnRowMessage)[] => {
      if (msg.kind !== 'turn') return [msg];
      const rows = buildTurnRows(msg.segments);
      const text = msg.segments.map((s) => s.kind === 'text' ? s.content : '').join('\n').trim();
      return rows.map((row, i) => ({
        kind: 'turn-row',
        id: `${msg.id}:${row.id}`,
        row,
        first: i === 0,
        last: i === rows.length - 1,
        actionText: i === rows.length - 1 && text ? text : undefined,
      }));
    });
  }, [visible, virtualizeTurnRows]);
  // 末尾是用户刚发出的消息时把它的 id 交给列表：新值出现就回到底部继续跟随。
  const last = visible[visible.length - 1];
  const followKey = last?.kind === 'user' ? last.id : null;
  return (
    <VirtualizedMessageList
      display={items}
      followKey={followKey}
      footer={footer}
      overlay={overlay}
      fill={fill}
      paddingInline={paddingInline}
      resetKey={resetKey}
      paddingBottom={paddingBottom}
      scrollRef={scrollRef}
      onGutterChange={onGutterChange}
      data-testid={testId}
      renderItem={(msg) => msg.kind === 'turn-row' ? (
        <TurnTimelineRow row={msg.row} first={msg.first} last={msg.last} actionText={msg.actionText} />
      ) : renderMessageBody(
          msg,
          unitsByMessage,
          answeredQuestions,
          showDeliverables,
          Boolean(liveId && msg.kind === 'turn' && msg.id === liveId),
          spawnOverlay,
        )}
    />
  );
}
