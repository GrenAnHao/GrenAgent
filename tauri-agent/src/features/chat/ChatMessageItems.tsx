import { lazy, Suspense } from 'react';
import type { DisplayMessage } from './groupMessages';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { NoticePill } from './NoticePill';
import { taskLabel } from '../panels/subagentUtils';

const ToolExecution = lazy(() =>
  import('../tools/ToolExecution').then((m) => ({ default: m.ToolExecution })),
);
const SubAgentInline = lazy(() =>
  import('./SubAgentInline').then((m) => ({ default: m.SubAgentInline })),
);

interface ChatMessageItemsProps {
  messages: DisplayMessage[];
}

/** 共享的对话气泡渲染：主对话与子代理对话复用同一套 user/assistant/tool/notice 组件。 */
export function ChatMessageItems({ messages }: ChatMessageItemsProps) {
  // spawn_agent 的全局序号（与右侧 RightPanel 的 #N tab 编号一致）。
  const subAgentIndex = new Map<string, number>();
  let subAgentCount = 0;
  for (const msg of messages) {
    if (msg.kind === 'tool' && msg.toolName === 'spawn_agent') {
      subAgentIndex.set(msg.id, ++subAgentCount);
    }
  }

  return (
    <>
      {messages.map((msg) => {
        switch (msg.kind) {
          case 'user':
            return <UserMessage key={msg.id} text={msg.text} />;
          case 'assistantGroup':
            return (
              <AssistantMessage
                key={msg.id}
                text={msg.text}
                thinking={msg.thinking}
                streaming={msg.streaming}
                thinkingDuration={msg.thinkingDuration}
                tools={msg.tools.length > 0 ? msg.tools : undefined}
              />
            );
          case 'tool':
            if (msg.toolName === 'spawn_agent') {
              return (
                <Suspense key={msg.id} fallback={null}>
                  <SubAgentInline
                    index={subAgentIndex.get(msg.id) ?? 1}
                    task={taskLabel(msg.args)}
                    result={msg.result}
                    status={msg.status}
                  />
                </Suspense>
              );
            }
            return (
              <Suspense key={msg.id} fallback={null}>
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
            return <NoticePill key={msg.id} customType={msg.customType} content={msg.content} />;
          default:
            return null;
        }
      })}
    </>
  );
}
