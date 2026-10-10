import { Fragment, memo, type ReactNode } from 'react';
import { Icon } from '@lobehub/ui';
import { EyeOff } from 'lucide-react';
import { createStaticStyles } from 'antd-style';
import { ChatItemShell } from './ChatItemShell';
import { MessageActionBar } from './messageActions/MessageActionBar';
import type { MessageActionContext } from './messageActions/types';
import { ReasoningInline } from './ReasoningInline';
import { LazyMarkdown } from './LazyMarkdown';
import { formatStructuredMessageText } from './structuredMessageText';
import { StructuredMessageBody } from './StructuredMessageBody';
import { ToolExecution } from '../tools/ToolExecution';
import { ContextToolGroup } from '../tools/ContextToolGroup';
import { isCodemodeTool } from '../tools/codemodeModel';
import type { TimelineSegment, ToolSegment } from './groupMessages';
import { buildTurnRows, type TurnRow } from './turnRows';
import { useOptionalAgentStoreContext } from '../../stores/AgentStoreContext';
import type { AgentStoreApi } from '../../stores/agent';
import { changesForTurn, presentedForTurn, turnSettled } from './turnDeliverables';
import { TurnTail } from './TurnTail';

const styles = createStaticStyles(({ css, cssVar }) => ({
  excludedTag: css`
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  nestedTools: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-inline-start: 12px;
  `,
}));

interface TurnTimelineProps {
  segments: TimelineSegment[];
  /** 该轮首条 assistant 消息的 pi 毫秒 timestamp：启用「移出上下文 / 回退到此」与排除标记。 */
  timestamp?: number;
  showDeliverables?: boolean;
  turnId?: string;
  /** 本轮仍是当前 agent run 的 live turn：工具间隙不要挂「已编辑」。 */
  live?: boolean;
}

function ToolSegmentBody({ segment }: { segment: ToolSegment }) {
  // codemode 自己把嵌套调用和 details.calls 合成一张列表画在卡片里。
  const ownsChildren = isCodemodeTool(segment.toolName);
  return (
    <>
      <ToolExecution
        toolName={segment.toolName}
        toolCallId={segment.toolCallId}
        args={segment.args}
        result={segment.result}
        status={segment.status}
        argsComplete={segment.argsComplete}
        startedAt={segment.startedAt}
        durationMs={segment.durationMs}
        nested={ownsChildren ? segment.children : undefined}
      />
      {!ownsChildren && segment.children && segment.children.length > 0 ? (
        <div className={styles.nestedTools}>
          {segment.children.map((child) => (
            <ToolSegmentBody key={child.id} segment={child} />
          ))}
        </div>
      ) : null}
    </>
  );
}

function sameTool(a: ToolSegment, b: ToolSegment): boolean {
  if (
    a.toolCallId !== b.toolCallId ||
    a.toolName !== b.toolName ||
    a.status !== b.status ||
    a.args !== b.args ||
    a.result !== b.result ||
    a.argsComplete !== b.argsComplete ||
    a.startedAt !== b.startedAt ||
    a.durationMs !== b.durationMs ||
    a.parentToolCallId !== b.parentToolCallId
  ) {
    return false;
  }
  const left = a.children ?? [];
  const right = b.children ?? [];
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (!sameTool(left[i]!, right[i]!)) return false;
  }
  return true;
}

function SegmentItem({ segment }: { segment: TimelineSegment }) {
  switch (segment.kind) {
    case 'thinking':
      return (
        <ReasoningInline
          content={segment.content}
          streaming={segment.streaming}
          durationMs={segment.durationMs}
          startedAt={segment.startedAt}
        />
      );
    case 'text':
      return (
        <StructuredMessageBody
          formatted={formatStructuredMessageText(segment.content)}
          fallback={
            <LazyMarkdown variant="chat" animated={segment.streaming}>
              {segment.content}
            </LazyMarkdown>
          }
        />
      );
    case 'tool':
      return <ToolSegmentBody segment={segment} />;
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
    return (
      a.content === b.content &&
      a.streaming === b.streaming &&
      a.durationMs === b.durationMs &&
      a.startedAt === b.startedAt
    );
  }
  if (a.kind === 'text' && b.kind === 'text') {
    return a.content === b.content && a.streaming === b.streaming;
  }
  if (a.kind === 'tool' && b.kind === 'tool') {
    return sameTool(a, b);
  }
  return false;
});

function renderTurnRow(row: TurnRow): ReactNode {
  return row.kind === 'context' ? (
    <ContextToolGroup tools={row.tools} />
  ) : (
    <MemoSegment segment={row.segment} />
  );
}

/** 子代理长工具循环按行虚拟化；整轮的复制入口只随最后一行渲染。 */
export function TurnTimelineRow({ row, first, last, actionText }: { row: TurnRow; first: boolean; last: boolean; actionText?: string }) {
  const actions = actionText ? (
    <MessageActionBar ctx={{ role: 'assistant', text: actionText }} bar={['copy']} menu={['copy']} />
  ) : undefined;
  // 列表每行已有上下各 4px，正好等于主时间线的 8px gap；消息的 8px padding 只留在整轮首尾。
  return (
    <ChatItemShell placement="left" actions={actions} paddingBlock={`${first ? 8 : 0}px ${last ? 8 : 0}px`}>
      {renderTurnRow(row)}
    </ChatItemShell>
  );
}

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
  showDeliverables: boolean,
  turnId: string | undefined,
  live: boolean,
  workspace: string,
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
      bar={['copy']}
      menu={['copy']}
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
      {rows.map((row) => <Fragment key={row.id}>{renderTurnRow(row)}</Fragment>)}
      {showDeliverables && turnId && !live && turnSettled(segments) ? (
        <TurnTail
          turnId={turnId}
          workspace={workspace}
          changes={changesForTurn(segments)}
          presented={presentedForTurn(segments)}
        />
      ) : null}
    </ChatItemShell>
  );
}

/** 有 store 上下文 + 带 timestamp：订阅排除态以显示标记并切换操作。 */
function ExcludableTurn({
  segments,
  timestamp,
  store,
  showDeliverables,
  turnId,
  live,
  workspace,
}: {
  segments: TimelineSegment[];
  timestamp: number;
  store: AgentStoreApi;
  showDeliverables: boolean;
  turnId?: string;
  live: boolean;
  workspace: string;
}) {
  const excluded = store.useStore((s) => s.excluded.has(timestamp));
  return renderTurn(segments, timestamp, excluded, showDeliverables, turnId, live, workspace);
}

export function TurnTimeline({ segments, timestamp, showDeliverables, turnId, live }: TurnTimelineProps) {
  const storeCtx = useOptionalAgentStoreContext();
  const workspace = storeCtx?.workspace ?? '';
  if (storeCtx && timestamp != null) {
    return (
      <ExcludableTurn
        segments={segments}
        timestamp={timestamp}
        store={storeCtx.store}
        showDeliverables={Boolean(showDeliverables)}
        turnId={turnId}
        live={Boolean(live)}
        workspace={workspace}
      />
    );
  }
  return renderTurn(segments, timestamp, false, Boolean(showDeliverables), turnId, Boolean(live), workspace);
}
