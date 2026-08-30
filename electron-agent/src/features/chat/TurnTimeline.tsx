import { memo, type ReactNode } from 'react';
import { Icon } from '@lobehub/ui';
import { EyeOff } from 'lucide-react';
import { createStaticStyles } from 'antd-style';
import { ChatItemShell } from './ChatItemShell';
import { MessageActionBar } from './messageActions/MessageActionBar';
import type { MessageActionContext } from './messageActions/types';
import { ReasoningInline } from './ReasoningInline';
import { LazyMarkdown } from './LazyMarkdown';
import { ToolExecution } from '../tools/ToolExecution';
import { ContextToolGroup } from '../tools/ContextToolGroup';
import type { TimelineSegment } from './groupMessages';
import { buildTurnRows } from './turnRows';
import { useOptionalAgentStoreContext } from '../../stores/AgentStoreContext';
import type { AgentStoreApi } from '../../stores/agent';

const styles = createStaticStyles(({ css, cssVar }) => ({
  excludedTag: css`
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
}));

interface TurnTimelineProps {
  segments: TimelineSegment[];
  /** 该轮首条 assistant 消息的 pi 毫秒 timestamp：启用「移出上下文 / 回退到此」与排除标记。 */
  timestamp?: number;
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
        <ToolExecution
          toolName={segment.toolName}
          toolCallId={segment.toolCallId}
          args={segment.args}
          result={segment.result}
          status={segment.status}
        />
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
/** 纯展示（不含 hooks）：供「带 store 订阅」与「无 store 降级」两条路径复用。 */
function renderTurn(
  segments: TimelineSegment[],
  timestamp: number | undefined,
  excluded: boolean,
): ReactNode {
  const rows = buildTurnRows(segments);
  const text = segments
    .map((s) => (s.kind === 'text' ? s.content : ''))
    .join('\n')
    .trim();
  const ctx: MessageActionContext = { role: 'assistant', text, timestamp };
  const actions = text ? (
    <MessageActionBar
      ctx={ctx}
      bar={['rewind', 'exclude', 'copy']}
      menu={['copy', 'divider', 'rewind', 'exclude']}
    />
  ) : undefined;
  return (
    <ChatItemShell placement="left" actions={actions}>
      {excluded ? (
        <span className={styles.excludedTag}>
          <Icon icon={EyeOff} size="small" />
          已移出上下文
        </span>
      ) : null}
      {rows.map((row) =>
        row.kind === 'context' ? (
          <ContextToolGroup key={row.id} tools={row.tools} />
        ) : (
          <MemoSegment key={row.id} segment={row.segment} />
        ),
      )}
    </ChatItemShell>
  );
}

/** 有 store 上下文 + 带 timestamp：订阅排除态以显示标记并切换操作。 */
function ExcludableTurn({
  segments,
  timestamp,
  store,
}: {
  segments: TimelineSegment[];
  timestamp: number;
  store: AgentStoreApi;
}) {
  const excluded = store.useStore((s) => s.excluded.has(timestamp));
  return renderTurn(segments, timestamp, excluded);
}

export function TurnTimeline({ segments, timestamp }: TurnTimelineProps) {
  const storeCtx = useOptionalAgentStoreContext();
  if (storeCtx && timestamp != null) {
    return <ExcludableTurn segments={segments} timestamp={timestamp} store={storeCtx.store} />;
  }
  return renderTurn(segments, timestamp, false);
}
