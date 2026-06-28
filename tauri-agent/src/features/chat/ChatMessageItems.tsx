import { lazy, Suspense, type ReactNode } from 'react';
import type { DisplayMessage } from './groupMessages';
import { UserMessage } from './UserMessage';
import { TurnTimeline } from './TurnTimeline';
import { NoticePill } from './NoticePill';
import { AnswerCard } from './AnswerCard';
import { PlanCard } from './PlanCard';
import { QuestionsCard } from './QuestionsCard';
import { VirtualizedMessageList } from './VirtualizedMessageList';
import { subAgentMode, taskLabel } from '../panels/subagentUtils';
import type { NumberedUnit } from './SubAgentGroupInline';

const ToolExecution = lazy(() =>
  import('../tools/ToolExecution').then((m) => ({ default: m.ToolExecution })),
);
const SubAgentInline = lazy(() =>
  import('./SubAgentInline').then((m) => ({ default: m.SubAgentInline })),
);
const SubAgentGroupInline = lazy(() =>
  import('./SubAgentGroupInline').then((m) => ({ default: m.SubAgentGroupInline })),
);

interface ChatMessageItemsProps {
  messages: DisplayMessage[];
  /** 全局预计算（由调用方 useMemo 缓存后传入）。 */
  unitsByMessage: Map<string, NumberedUnit[]>;
  answeredQuestions: Set<string>;
  /** 列表末尾附加元素（如「准备响应中」占位）。 */
  footer?: ReactNode;
  /** 填充方式：主对话父容器 position:relative → 'absolute'；子代理面板 flex 子项 → 'flex'（默认）。 */
  fill?: 'absolute' | 'flex';
  /** 每条消息左右内边距（主对话 24，子代理 16）。 */
  paddingInline?: number;
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
            <Suspense fallback={null}>
              <SubAgentInline
                messageId={msg.id}
                toolCallId={msg.toolCallId}
                index={only?.no ?? 1}
                task={only?.unit.task ?? taskLabel(msg.args)}
                result={msg.result}
                status={msg.status}
              />
            </Suspense>
          );
        }
        return (
          <Suspense fallback={null}>
            <SubAgentGroupInline
              messageId={msg.id}
              toolCallId={msg.toolCallId}
              mode={subAgentMode(msg.args)}
              status={msg.status}
              units={numbered}
            />
          </Suspense>
        );
      }
      return (
        <Suspense fallback={null}>
          <ToolExecution
            toolName={msg.toolName}
            toolCallId={msg.toolCallId}
            args={msg.args}
            result={msg.result}
            status={msg.status}
          />
        </Suspense>
      );
    case 'notice':
      if (msg.customType === 'agent-answer') return <AnswerCard content={msg.content} />;
      if (msg.customType === 'agent-plan') return <PlanCard content={msg.content} />;
      if (msg.customType === 'agent-questions') {
        return <QuestionsCard answered={answeredQuestions.has(msg.id)} content={msg.content} />;
      }
      return <NoticePill customType={msg.customType} content={msg.content} />;
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
  fill,
  paddingInline,
  'data-testid': testId,
}: ChatMessageItemsProps) {
  return (
    <VirtualizedMessageList
      display={messages}
      footer={footer}
      fill={fill}
      paddingInline={paddingInline}
      data-testid={testId}
      renderItem={(msg) => renderMessageBody(msg, unitsByMessage, answeredQuestions)}
    />
  );
}
