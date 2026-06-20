import { Suspense, lazy, memo } from 'react';
import { ChatItemShell } from './ChatItemShell';
import { MessageActionBar } from './messageActions/MessageActionBar';
import { ReasoningInline } from './ReasoningInline';
import { LazyMarkdown } from './LazyMarkdown';
import type { TimelineSegment } from './groupMessages';
import { buildTurnRows } from './turnRows';

const ToolExecution = lazy(() =>
  import('../tools/ToolExecution').then((m) => ({ default: m.ToolExecution })),
);
const ContextToolGroup = lazy(() =>
  import('../tools/ContextToolGroup').then((m) => ({ default: m.ContextToolGroup })),
);

interface TurnTimelineProps {
  segments: TimelineSegment[];
}

function SegmentItem({ segment }: { segment: TimelineSegment }) {
  switch (segment.kind) {
    case 'thinking':
      return (
        <ReasoningInline
          content={segment.content}
          streaming={segment.streaming}
          durationMs={segment.durationMs}
        />
      );
    case 'text':
      return (
        <LazyMarkdown variant="chat" fontSize={14} animated={segment.streaming}>
          {segment.content}
        </LazyMarkdown>
      );
    case 'tool':
      return (
        <Suspense fallback={null}>
          <ToolExecution
            toolName={segment.toolName}
            toolCallId={segment.toolCallId}
            args={segment.args}
            result={segment.result}
            status={segment.status}
          />
        </Suspense>
      );
    default:
      return null;
  }
}

/**
 * 单段记忆化：groupMessages 每次（流式节流 tick）都会重建 segments 数组与各段对象，
 * 但 segment.id 稳定。这里按值比较，让已完成的思考/工具/正文段不随流式 tick 重渲染，
 * 只有当前活跃段（内容仍在增长的那段）会更新——根治此前「响应内容疯狂重刷」。
 */
const MemoSegment = memo(SegmentItem, (prev, next) => {
  const a = prev.segment;
  const b = next.segment;
  if (a.kind !== b.kind || a.id !== b.id) return false;
  if (a.kind === 'thinking' && b.kind === 'thinking') {
    return a.content === b.content && a.streaming === b.streaming && a.durationMs === b.durationMs;
  }
  if (a.kind === 'text' && b.kind === 'text') {
    return a.content === b.content && a.streaming === b.streaming;
  }
  if (a.kind === 'tool' && b.kind === 'tool') {
    return (
      a.toolCallId === b.toolCallId &&
      a.toolName === b.toolName &&
      a.status === b.status &&
      a.args === b.args &&
      a.result === b.result
    );
  }
  return false;
});

/**
 * 助手回合时间线：把同一轮的 reasoning / tool / text 按真实发生顺序平铺渲染
 *（对齐 MiMo SessionTurn / AssistantParts），每段独立、稳定 key；连续的查找类工具
 * 折叠成一条上下文摘要，动作工具逐个单独展示。
 *
 * 不对本组件做 memo / useMemo：segments 每个流式 tick 都是新数组引用，外层记忆化无从命中；
 * buildTurnRows 只是 O(n) 重排，开销可忽略。真正的重渲染边界在 MemoSegment 与 ContextToolGroup
 * 自身（按值比较），由它们拦住已完成段的重复渲染。
 */
export function TurnTimeline({ segments }: TurnTimelineProps) {
  const rows = buildTurnRows(segments);
  const text = segments
    .map((s) => (s.kind === 'text' ? s.content : ''))
    .join('\n')
    .trim();
  const actions = text ? (
    <MessageActionBar ctx={{ role: 'assistant', text }} bar={['copy']} />
  ) : undefined;
  return (
    <ChatItemShell placement="left" actions={actions}>
      {rows.map((row) =>
        row.kind === 'context' ? (
          <Suspense key={row.id} fallback={null}>
            <ContextToolGroup tools={row.tools} />
          </Suspense>
        ) : (
          <MemoSegment key={row.id} segment={row.segment} />
        ),
      )}
    </ChatItemShell>
  );
}
