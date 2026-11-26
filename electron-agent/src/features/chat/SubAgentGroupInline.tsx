import { ActionIcon, Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import {
  Ban,
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
import { isModelAlias, modelWithThinking, subAgentCardTitle, subAgentFinalText, subAgentHasResponded, subAgentStartupPhase, type SubAgentMode, type SubAgentUnit, type SubAgentUnitStatus } from '../panels/subagentUtils';
import { PendingResponseStatus } from './PendingResponseStatus';
import { useProviderNames } from '../settings/providerListCache';
import { dockOwnerFromStore, useDockStore } from '../../stores/dockStore';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { pi } from '../../lib/pi';
import { observationKey, subAgentObservationUnconfirmed, useSubAgentLiveStore, type SubAgentObservation } from '../../stores/subagentLiveStore';

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
  error: css`
    max-height: 160px;
    overflow: auto;
    padding: 8px 12px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorErrorBg};
    color: ${cssVar.colorError};
    font-size: 12px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
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

function modelText(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

interface LiveRow {
  unit: SubAgentUnit;
  createdAt?: number;
  unconfirmed?: boolean;
  phase?: ReturnType<typeof subAgentStartupPhase>;
}

/** 只以该子项的 agentId 认登记行；缺身份时按父调用/位置保留占位，不猜同名任务。 */
function withLiveStart(unit: SubAgentUnit, observation: SubAgentObservation | undefined, listGeneration: number, toolDone: boolean): LiveRow {
  if (unit.status === 'waiting' || unit.status === 'pending') return { unit };
  const match = observation?.item;
  // 已完结的行只缺字段时用登记行补元数据：状态永远跟调用结果，旧 running 不能把完成卡重新点着。
  if (unit.status === 'done' || unit.status === 'error') {
    if (unit.model && unit.thinkingLevel) return { unit };
    const model = (isModelAlias(unit.model) ? undefined : unit.model) || modelText(match?.model);
    const thinkingLevel = unit.thinkingLevel || modelText(match?.thinkingLevel);
    if (!model && !thinkingLevel) return { unit };
    return { unit: { ...unit, ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) } };
  }
  const phase = subAgentStartupPhase({ parentStatus: toolDone ? 'done' : 'running', background: toolDone,
    registry: match, hasResponse: subAgentHasResponded(match),
    unconfirmed: unit.agentId ? Boolean(observation && subAgentObservationUnconfirmed(observation)) : listGeneration >= 3 });
  const terminal = phase === 'done' ? 'done' : phase === 'error' || phase === 'cancelled' || phase === 'interrupted' ? 'error' : undefined;
  const status: SubAgentUnitStatus = terminal ?? (phase === 'starting' ? 'starting' : 'running');
  const model = (isModelAlias(unit.model) ? undefined : unit.model) || modelText(match?.model) || unit.model;
  const thinkingLevel = unit.thinkingLevel || modelText(match?.thinkingLevel);
  return { unit: { ...unit, status, ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) },
    createdAt: match?.createdAt || undefined, unconfirmed: phase === 'status-unconfirmed', phase };
}

function statusMeta(status: SubAgentUnitStatus, phase?: LiveRow['phase']) {
  if (phase === 'cancelled') return { icon: Ban, color: cssVar.colorTextTertiary, spin: false, label: '已停止' };
  if (phase === 'interrupted') return { icon: CircleDashed, color: cssVar.colorTextTertiary, spin: false, label: '已中断' };
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
  /** 调用级错误在逐项结果产生前也必须可见；正常批次仍只按逐项状态展示。 */
  result?: unknown;
}

/**
 * 并行/链式子代理组：把「一次 spawn_agent 调用」展开成每个子代理一行，序号显式（#N）。
 * 每行点击在右坞打开该子代理的会话；运行中可在组头一键停止整组。
 */
function SubAgentGroupInlineInner({ messageId, toolCallId, mode, status, units, result }: SubAgentGroupInlineProps) {
  const card = cardStyles;
  const { workspace, store } = useAgentStoreContext();
  const running = status === 'running';
  const ownerPath = store.getLoadedSessionPath() ?? '';
  const watch = useSubAgentLiveStore((s) => s.watch);
  const startPolling = useSubAgentLiveStore((s) => s.startPolling);
  const observations = useSubAgentLiveStore((s) => s.observations);
  const listGeneration = useSubAgentLiveStore((s) => s.listQueries.get(workspace)?.generation ?? 0);
  const [startGeneration] = useState(() => listGeneration);
  const providerNames = useProviderNames();
  const watchedIds = units.filter((u) => {
    if (!u.unit.agentId || !(u.unit.status === 'running' || u.unit.status === 'starting' || !u.unit.model)) return false;
    const observed = observations.get(observationKey(workspace, ownerPath, u.unit.agentId));
    return !['done', 'error', 'cancelled', 'interrupted'].includes(observed?.item?.status ?? '');
  }).map((u) => u.unit.agentId!).join(',');
  useEffect(() => {
    if (!ownerPath) return;
    const unwatch = watchedIds.split(',').filter(Boolean).map((id) => watch(workspace, ownerPath, id));
    return () => unwatch.forEach((release) => release());
  }, [workspace, ownerPath, watchedIds, watch]);
  const hasUnidentified = units.some((u) => !u.unit.agentId && (u.unit.status === 'running' || u.unit.status === 'starting'));
  useEffect(() => {
    if (!workspace || (!running && !hasUnidentified) || (hasUnidentified && !running && listGeneration - startGeneration >= 3)) return;
    return startPolling(workspace);
  }, [workspace, running, hasUnidentified, listGeneration, startGeneration, startPolling]);
  const shownRows = units.map((u) => ({ u, live: withLiveStart(u.unit,
    u.unit.agentId ? observations.get(observationKey(workspace, ownerPath, u.unit.agentId)) : undefined,
    listGeneration - startGeneration, !running) }));
  const backgroundCount = running ? 0 : shownRows.filter((r) => r.live.unit.status === 'running' && !r.live.unconfirmed).length;
  const errorCount = shownRows.filter((r) => r.live.unit.status === 'error'
    && r.live.phase !== 'cancelled' && r.live.phase !== 'interrupted').length;

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
  const detailError = (result as { details?: { error?: unknown } } | null)?.details?.error;
  const callError = status === 'error'
    ? subAgentFinalText(result) || (typeof detailError === 'string' ? detailError : '')
    : '';

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
      {callError ? <div className={styles.error} role="alert" data-testid="subagent-group-error">{callError}</div> : null}
      <div className={styles.rows}>
        {(() => {
          return shownRows.map(({ u, live: liveRow }) => {
            const shown = liveRow.unit;
            const sm = statusMeta(shown.status, liveRow.phase);
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
                {liveRow.unconfirmed ? '状态待确认'
                  : pending ? <PendingResponseStatus label={liveRow.phase === 'starting' ? '启动中…' : liveRow.phase === 'awaiting-first-response' ? '等待首响应…' : '正在处理…'} startedAt={liveRow.createdAt} dot={false} size="inherit" />
                    : sm.label}
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
