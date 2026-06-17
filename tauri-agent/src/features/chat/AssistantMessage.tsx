import { Suspense, lazy, memo } from 'react';
import { ChatItemShell } from './ChatItemShell';
import { Thinking } from './Thinking';
import { LazyMarkdown } from './LazyMarkdown';
import { PreparingIndicator } from './PreparingIndicator';

const ToolExecution = lazy(() =>
  import('../tools/ToolExecution').then((m) => ({ default: m.ToolExecution })),
);
const WorkflowCollapse = lazy(() =>
  import('../tools/WorkflowCollapse').then((m) => ({ default: m.WorkflowCollapse })),
);

/** Tool calls associated with an assistant turn (shape matches groupMessages' ToolDisplay). */
export interface AssistantToolItem {
  id: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  result: unknown;
  status: 'running' | 'done' | 'error';
}

interface AssistantMessageProps {
  text: string;
  thinking: string;
  streaming: boolean;
  thinkingDuration?: number;
  /** Optional inline tool calls rendered beneath the answer (grouped-message rendering). */
  tools?: AssistantToolItem[];
}

/**
 * 助手消息：自研无头像外壳 + 垂直 ContentBlock 栈，顺序固定 Reasoning → Markdown → Tools。
 * 对齐 lobehub：去掉 lobe `ChatItem variant=docs`，正文直接走 `LazyMarkdown`。
 */
function AssistantMessageInner({
  text,
  thinking,
  streaming,
  thinkingDuration,
  tools,
}: AssistantMessageProps) {
  const reasoning = streaming && !text;
  // 流式中尚无任何可见内容时，在助手槽内显示「准备响应中」——与正文同槽，首字到达时
  // 原地替换而非新增/移除元素，避免对话项抖动。
  const preparing = streaming && !text && !thinking && (!tools || tools.length === 0);

  return (
    <ChatItemShell placement="left">
      {preparing ? <PreparingIndicator bare /> : null}
      {thinking ? (
        <Thinking content={thinking} thinking={reasoning} duration={thinkingDuration} />
      ) : null}
      {text ? (
        <LazyMarkdown variant="chat" fontSize={14} animated={streaming}>
          {text}
        </LazyMarkdown>
      ) : null}
      {tools && tools.length > 0 ? (
        <Suspense fallback={null}>
          {tools.length > 1 ? (
            <WorkflowCollapse tools={tools} />
          ) : (
            <ToolExecution
              toolName={tools[0].toolName}
              toolCallId={tools[0].toolCallId}
              args={tools[0].args}
              result={tools[0].result}
              status={tools[0].status}
            />
          )}
        </Suspense>
      ) : null}
    </ChatItemShell>
  );
}

/**
 * 自定义比较：groupMessages 每次都会新建 assistantGroup 与 tools 数组（引用必变），
 * 默认浅比较会让所有带工具的助手消息在每次流式 tick 都重渲染。
 * 这里按值比较基础字段，并对 tools 逐项比对 toolCallId/status/args/result 引用
 * （store 对未变消息保持引用稳定）——只有本条助手消息自身变化时才重渲染。
 */
function areEqual(prev: AssistantMessageProps, next: AssistantMessageProps): boolean {
  if (
    prev.text !== next.text ||
    prev.thinking !== next.thinking ||
    prev.streaming !== next.streaming ||
    prev.thinkingDuration !== next.thinkingDuration
  ) {
    return false;
  }
  const a = prev.tools;
  const b = next.tools;
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].toolCallId !== b[i].toolCallId ||
      a[i].toolName !== b[i].toolName ||
      a[i].status !== b[i].status ||
      a[i].args !== b[i].args ||
      a[i].result !== b[i].result
    ) {
      return false;
    }
  }
  return true;
}

export const AssistantMessage = memo(AssistantMessageInner, areEqual);
