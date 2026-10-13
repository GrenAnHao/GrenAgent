import { ActionIcon, Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import {
  CheckCircle2,
  CircleDashed,
  CircleStop,
  Clock,
  GitBranch,
  Loader2,
  PanelRightOpen,
  Rows3,
  XCircle,
} from 'lucide-react';
import { memo, useEffect, useState, type MouseEvent } from 'react';
import { cardStyles } from '../tools/cardStyles';
import { ModelNameTag } from './ModelNameTag';
import { isModelAlias, modelWithThinking, subAgentCardTitle, type SubAgentMode, type SubAgentUnit, type SubAgentUnitStatus } from '../panels/subagentUtils';
import { PendingResponseStatus } from './PendingResponseStatus';
import { useProviderNames } from '../settings/providerListCache';
import { dockOwnerFromStore, useDockStore } from '../../stores/dockStore';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { pi } from '../../lib/pi';
import type { SubAgentItem } from '../../lib/pi';
import { selectSubAgentList, useSubAgentLiveStore } from '../../stores/subagentLiveStore';

const styles = createStaticStyles(({ css }) => ({
  group: css`
    display: flex;
    flex-direction: column;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillQuaternary};
    overflow: hidden;
  `,
  head: css`
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    user-select: none;
  `,
  headTitle: css`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    color: ${cssVar.colorText};
    font-weight: 600;
  `,
  count: css`
    font-weight: 400;
    color: ${cssVar.colorTextTertiary};
  `,
  fail: css`
    font-weight: 600;
    color: ${cssVar.colorWarning};
  `,
  rows: css`
    display: flex;
    flex-direction: column;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  row: css`
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    cursor: pointer;

    & + & {
      border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    }

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  no: css`
    flex: none;
    font-size: 12px;
    font-weight: 600;
    color: ${cssVar.colorTextSecondary};
  `,
  task: css`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    color: ${cssVar.colorTextSecondary};
  `,
  badge: css`
    flex: none;
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
  `,
}));

const NO_IDS: ReadonlySet<string> = new Set();

function modelText(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function terminalStatus(status: string | undefined): SubAgentUnitStatus | undefined {
  if (status === 'done') return 'done';
  return status === 'error' || status === 'cancelled' ? 'error' : undefined;
}

/** 同一任务文字在注册表里最新的那一行。 */
function newestByTask(items: SubAgentItem[], task: string, used: Set<string>): SubAgentItem | undefined {
  let best: SubAgentItem | undefined;
  for (const item of items) {
    if (used.has(item.id) || item.task !== task) continue;
    if (!best || (item.createdAt ?? 0) > (best.createdAt ?? 0)) best = item;
  }
  return best;
}

interface LiveRow {
  unit: SubAgentUnit;
  createdAt?: number;
  /** 转到后台的那一项在手上这份注册表里找不到。这份可能是它建出来之前读的，还要再读一次确认。 */
  missing?: boolean;
  /** 工具返回之后读的注册表里也找不到（被删，或被更新的行挤出列表）。 */
  interrupted?: boolean;
}

/**
 * 每行合上注册表里的实况。
 * toolDone：这次 spawn_agent 已经返回。那时还画着运行中的行，是前台 run 转到后台的那几个（detach.ts）。
 * registryKnown：注册表至少读到过一次，「找不到」才作数。
 * gone：工具返回之后再读注册表确认不在的 agentId。
 */
function withLiveStart(
  unit: SubAgentUnit,
  items: SubAgentItem[],
  used: Set<string>,
  opts: { toolDone: boolean; registryKnown: boolean; gone: ReadonlySet<string> },
): LiveRow {
  const active = unit.status === 'starting' || unit.status === 'running';
  const detached = opts.toolDone && unit.status === 'running';
  const match = unit.status === 'waiting' || unit.status === 'pending'
    ? undefined
    : unit.agentId
      ? items.find((item) => !used.has(item.id) && item.id === unit.agentId)
      // 转后台时还没轮到、没有 agentId 的那一项：它在后台起来以后是同一任务文字最新的一行，在跑或已经结束都算。
      : detached
        ? newestByTask(items, unit.task, used)
        : items.find((item) =>
          !used.has(item.id) && item.task === unit.task && (active
            ? item.status === 'running' || item.status === 'starting'
            : terminalStatus(item.status) !== undefined));
  if (match) used.add(match.id);
  // 行上的 cheap / strong 来自调用参数，只是别名；注册表里有实际路由时用注册表。
  const model = (isModelAlias(unit.model) ? undefined : unit.model) || modelText(match?.model) || unit.model;
  // 实际档位：结果行里的优先，运行中再看注册表。
  const thinkingLevel = unit.thinkingLevel || modelText(match?.thinkingLevel);
  // 行还画着运行中、注册表已经结束（转到后台的那一项跑完了）：按注册表的终态画。
  const finished = unit.status === 'running' && match && (unit.agentId || detached) ? terminalStatus(match.status) : undefined;
  const missing = detached && !match && Boolean(unit.agentId) && opts.registryKnown;
  // 和单任务的后台卡片一样（backgroundRegistryStatus）：注册表里确实没有，按「已中断」画，不能一直转圈、一直轮询。
  const interrupted = missing && opts.gone.has(unit.agentId!);
  const status = finished ?? (interrupted ? 'error' : unit.status === 'starting' && match?.sessionPath ? 'running' : unit.status);
  const createdAt = typeof match?.createdAt === 'number' && match.createdAt > 0 ? match.createdAt : undefined;
  const next =
    model === unit.model && thinkingLevel === unit.thinkingLevel && status === unit.status
      ? unit
      : { ...unit, status, ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) };
  return { unit: next, createdAt, ...(missing ? { missing } : {}), ...(interrupted ? { interrupted } : {}) };
}

function statusMeta(status: SubAgentUnitStatus) {
  switch (status) {
    case 'starting':
      return { icon: Loader2, color: cssVar.colorTextSecondary, spin: true, label: '启动中' };
    case 'running':
      return { icon: Loader2, color: cssVar.colorTextSecondary, spin: true, label: '运行中…' };
    case 'done':
      return { icon: CheckCircle2, color: cssVar.colorSuccess, spin: false, label: '已完成' };
    case 'error':
      return { icon: XCircle, color: cssVar.colorError, spin: false, label: '出错' };
    case 'waiting':
      return { icon: Clock, color: cssVar.colorTextQuaternary, spin: false, label: '等待上一步完成' };
    default:
      return { icon: CircleDashed, color: cssVar.colorTextQuaternary, spin: false, label: '未执行' };
  }
}

export interface NumberedUnit {
  unit: SubAgentUnit;
  no: number;
}

interface SubAgentGroupInlineProps {
  messageId: string;
  toolCallId: string;
  mode: SubAgentMode;
  status: 'running' | 'done' | 'error';
  units: NumberedUnit[];
}

/**
 * 并行/链式子代理组：把「一次 spawn_agent 调用」展开成每个子代理一行，序号显式（#N）。
 * 每行点击在右坞打开该子代理的会话；运行中可在组头一键停止整组。
 */
function SubAgentGroupInlineInner({ messageId, toolCallId, mode, status, units }: SubAgentGroupInlineProps) {
  const card = cardStyles;
  const { workspace, store } = useAgentStoreContext();
  const running = status === 'running';
  const startPolling = useSubAgentLiveStore((s) => s.startPolling);
  const liveItems = useSubAgentLiveStore(selectSubAgentList(workspace));
  const registryLoaded = useSubAgentLiveStore((s) => s.itemsByWorkspace.has(workspace));
  const modelGap = units.some((u) => (!u.unit.model || isModelAlias(u.unit.model)) && u.unit.status !== 'waiting' && u.unit.status !== 'pending');
  const [remembered, setRemembered] = useState<SubAgentItem[]>([]);
  const [registryRead, setRegistryRead] = useState(false);
  const providerNames = useProviderNames();
  const knownItems = liveItems.length > 0 ? liveItems : remembered;
  const [goneIds, setGoneIds] = useState<ReadonlySet<string>>(NO_IDS);
  // 每行合上注册表里的实况。工具已经返回、还有行在跑的，是前台 run 转到后台的那几个（detach.ts）。
  const shownRows = (() => {
    const used = new Set<string>();
    const opts = { toolDone: !running, registryKnown: registryLoaded || registryRead, gone: goneIds };
    return units.map((u) => ({ u, live: withLiveStart(u.unit, knownItems, used, opts) }));
  })();
  const backgroundCount = running ? 0 : shownRows.filter((r) => r.live.unit.status === 'running').length;
  // 转到后台的行在 store 那份注册表里找不到：那份可能是这些行建出来之前读的（run 一开始就转后台时，
  // 下一次轮询还没到）。工具返回之后自己再读一次，确实没有才画「已中断」。
  const unconfirmed = shownRows.filter((r) => r.live.missing && !r.live.interrupted).map((r) => r.u.unit.agentId!).join(',');
  useEffect(() => {
    if (!workspace || !unconfirmed) return;
    let cancelled = false;
    const ids = unconfirmed.split(',');
    void pi.subagentList(workspace).then((rows) => {
      if (cancelled) return;
      const present = new Set(rows.map((row) => row.id));
      const gone = ids.filter((id) => !present.has(id));
      if (gone.length > 0) setGoneIds((prev) => new Set([...prev, ...gone]));
    }).catch(() => {
      /* 跨进程读注册表偶发 SQLITE_BUSY：行照旧画运行中，store 的轮询接着找它 */
    });
    return () => {
      cancelled = true;
    };
  }, [workspace, unconfirmed]);
  useEffect(() => {
    if (!workspace || (!running && backgroundCount === 0 && (!modelGap || registryRead))) return;
    return startPolling(workspace);
  }, [workspace, running, backgroundCount, modelGap, registryRead, startPolling]);
  // 工具返回时还有行在跑（转到后台的那几个）：要记住注册表的最后一份。它们都结束后轮询停掉、store 清空，
  // 不记住的话行会退回「运行中」，又把轮询拉起来，来回抖。
  const hasDetached = !running && units.some((u) => u.unit.status === 'running');
  useEffect(() => {
    if (!registryLoaded || (!modelGap && !hasDetached)) return;
    setRemembered(liveItems);
    setRegistryRead(true);
  }, [registryLoaded, modelGap, hasDetached, liveItems]);
  // 组头成败汇总：非运行态时统计失败子代理数（与工具聚合一致，部分失败用琥珀计数而非整组标红）。
  // 转到后台的行按注册表的终态算；已中断的不知道结果，不算失败，行上自己写「已中断」。
  const errorCount = shownRows.filter((r) => r.live.unit.status === 'error' && !r.live.interrupted).length;

  const open = (u: NumberedUnit) => {
    useDockStore.getState().openSubAgent({
      messageId,
      toolCallId,
      subIndex: u.unit.subIndex,
      title: `#${u.no} ${subAgentCardTitle(u.unit.title, u.unit.task)}`,
      // tab 归属当前渲染这条消息的会话，切会话后不跟过去。
      ...dockOwnerFromStore(store, workspace),
    });
  };

  const stop = (e: MouseEvent) => {
    e.stopPropagation();
    void pi.abort(workspace, store.getLoadedSessionPath());
  };

  const groupIcon = mode === 'chain' ? GitBranch : Rows3;
  const groupLabel = mode === 'chain' ? '链式子代理' : '并行子代理';
  const unit = mode === 'chain' ? '步' : '个';

  return (
    <div className={styles.group} data-testid="subagent-group">
      <div className={styles.head}>
        <Icon
          icon={running ? Loader2 : groupIcon}
          size={14}
          spin={running}
          style={{ flex: 'none', color: cssVar.colorTextSecondary }}
        />
        <span className={cx(styles.headTitle, running && card.shinyText)}>
          {groupLabel}{' '}
          <span className={styles.count}>
            · {units.length} {unit}
            {!running && errorCount > 0 ? (
              <span className={styles.fail}> · {errorCount} 个失败</span>
            ) : null}
            {backgroundCount > 0 ? (
              <span data-testid="subagent-group-background"> · {backgroundCount} 个在后台运行</span>
            ) : null}
          </span>
        </span>
        {running ? <ActionIcon icon={CircleStop} size="small" title="停止整组子代理" onClick={stop} /> : null}
      </div>
      <div className={styles.rows}>
        {(() => {
          return shownRows.map(({ u, live: liveRow }) => {
            const shown = liveRow.unit;
            const sm = statusMeta(shown.status);
            const pending = shown.status === 'running' || shown.status === 'starting';
            const modelLabel = modelWithThinking(shown.model, shown.thinkingLevel, providerNames);
            return (
            <div
              key={u.unit.key}
              className={styles.row}
              onClick={() => open(u)}
              title="在右侧面板查看该子代理详情"
              data-testid={`subagent-group-row-${u.no}`}
            >
              <Icon icon={sm.icon} size={14} spin={sm.spin} style={{ flex: 'none', color: sm.color }} />
              <span className={styles.no}>#{u.no}</span>
              <span className={cx(styles.task, pending && card.shinyText)}>{subAgentCardTitle(shown.title, shown.task)}</span>
              {modelLabel ? <ModelNameTag name={modelLabel} testId="subagent-step-model" /> : null}
              <span className={styles.badge}>
                {pending ? (
                  <PendingResponseStatus label="正在处理…" startedAt={liveRow.createdAt} dot={false} size="inherit" />
                ) : liveRow.interrupted ? (
                  '已中断'
                ) : (
                  sm.label
                )}
              </span>
              <ActionIcon icon={PanelRightOpen} size="small" title="在右侧面板打开" onClick={(e) => { e.stopPropagation(); open(u); }} />
            </div>
            );
          });
        })()}
      </div>
    </div>
  );
}

export const SubAgentGroupInline = memo(SubAgentGroupInlineInner);
