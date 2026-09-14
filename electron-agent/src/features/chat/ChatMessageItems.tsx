import { type ReactNode, type Ref } from 'react';
import { createStaticStyles, cssVar } from 'antd-style';
import type { DisplayMessage } from './groupMessages';
import { UserMessage } from './UserMessage';
import { TurnTimeline } from './TurnTimeline';
import { NoticePill } from './NoticePill';
import { SubagentSettledPill } from './SubagentSettledPill';
import { JobDonePill } from './JobDonePill';
import { UiPromptReceipt } from './UiPromptReceipt';
import { AnswerCard } from './AnswerCard';
import { PlanCard } from './PlanCard';
import { QuestionsCard } from './QuestionsCard';
import { VisualCard } from '../visual/VisualCard';
import { VirtualizedMessageList, type MessageListViewport, type TranscriptScrollHandle } from './VirtualizedMessageList';
import { ToolExecution } from '../tools/ToolExecution';
import { SubAgentInline } from './SubAgentInline';
import { SubAgentGroupInline, type NumberedUnit } from './SubAgentGroupInline';
import { subAgentMode, taskLabel } from '../panels/subagentUtils';
import { ChatTagView } from './input/editor/ChatTag/ChatTagView';

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

interface ChatMessageItemsProps {
  messages: DisplayMessage[];
  /** 全局预计算（由调用方 useMemo 缓存后传入）。 */
  unitsByMessage: Map<string, NumberedUnit[]>;
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
}

/** 单条消息渲染器：user/assistant(turn)/tool/notice 分发；主对话与子代理对话共用。 */
export function renderMessageBody(
  msg: DisplayMessage,
  unitsByMessage: Map<string, NumberedUnit[]>,
  answeredQuestions: Set<string>,
): ReactNode {
  switch (msg.kind) {
    case 'user':
      return <UserMessage text={msg.text} images={msg.images} timestamp={msg.timestamp} />;
    case 'turn':
      return <TurnTimeline segments={msg.segments} timestamp={msg.timestamp} />;
    case 'tool':
      if (msg.toolName === 'spawn_agent') {
        const numbered = unitsByMessage.get(msg.id) ?? [];
        if (numbered.length <= 1) {
          const only = numbered[0];
          return (
            <SubAgentInline
              messageId={msg.id}
              toolCallId={msg.toolCallId}
              index={only?.no ?? 1}
              task={only?.unit.task ?? taskLabel(msg.args)}
              result={msg.result}
              status={msg.status}
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
        />
      );
    case 'notice':
      if (msg.customType === 'agent-answer') return <AnswerCard content={msg.content} />;
      if (msg.customType === 'agent-plan') return <PlanCard content={msg.content} />;
      if (msg.customType === 'agent-questions') {
        return <QuestionsCard answered={answeredQuestions.has(msg.id)} content={msg.content} />;
      }
      if (msg.customType === 'visual-inline') return <VisualCard content={msg.content} />;
      if (msg.customType === 'subagent-settled') return <SubagentSettledPill content={msg.content} />;
      if (msg.customType === 'job-done') return <JobDonePill content={msg.content} />;
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
}: ChatMessageItemsProps) {
  return (
    <VirtualizedMessageList
      display={messages}
      footer={footer}
      overlay={overlay}
      fill={fill}
      paddingInline={paddingInline}
      resetKey={resetKey}
      paddingBottom={paddingBottom}
      scrollRef={scrollRef}
      onGutterChange={onGutterChange}
      data-testid={testId}
      renderItem={(msg) => renderMessageBody(msg, unitsByMessage, answeredQuestions)}
    />
  );
}
