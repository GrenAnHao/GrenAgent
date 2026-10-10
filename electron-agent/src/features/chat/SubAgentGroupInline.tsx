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

function modelText(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function withLiveStart(
  unit: SubAgentUnit,
  items: SubAgentItem[],
  used: Set<string>,
): { unit: SubAgentUnit; createdAt?: number } {
  const active = unit.status === 'starting' || unit.status === 'running';
  const match = unit.status === 'waiting' || unit.status === 'pending' ? undefined : items.find((item) =>
    !used.has(item.id) && (unit.agentId
      ? item.id === unit.agentId
      : item.task === unit.task && (active
        ? item.status === 'running' || item.status === 'starting'
        : item.status === 'done' || item.status === 'error' || item.status === 'cancelled')),
  );
  if (match) used.add(match.id);
  // 行上的 cheap / strong 来自调用参数，只是别名；注册表里有实际路由时用注册表。
  const model = (isModelAlias(unit.model) ? undefined : unit.model) || modelText(match?.model) || unit.model;
  // 实际档位：结果行里的优先，运行中再看注册表。
  const thinkingLevel = unit.thinkingLevel || modelText(match?.thinkingLevel);
  const status = unit.status === 'starting' && match?.sessionPath ? 'running' : unit.status;
  const createdAt = typeof match?.createdAt === 'number' && match.createdAt > 0 ? match.createdAt : undefined;
  const next =
    model === unit.model && thinkingLevel === unit.thinkingLevel && status === unit.status
      ? unit
      : { ...unit, status, ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) };
  return { unit: next, createdAt };
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
  useEffect(() => {
    if (!workspace || (!running && (!modelGap || registryRead))) return;
    return startPolling(workspace);
  }, [workspace, running, modelGap, registryRead, startPolling]);
  useEffect(() => {
    if (!registryLoaded || !modelGap) return;
    setRemembered(liveItems);
    setRegistryRead(true);
  }, [registryLoaded, modelGap, liveItems]);
  const knownItems = liveItems.length > 0 ? liveItems : remembered;
  // 组头成败汇总：非运行态时统计失败子代理数（与工具聚合一致，部分失败用琥珀计数而非整组标红）。
  const errorCount = units.filter((u) => u.unit.status === 'error').length;

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
          </span>
        </span>
        {running ? <ActionIcon icon={CircleStop} size="small" title="停止整组子代理" onClick={stop} /> : null}
      </div>
      <div className={styles.rows}>
        {(() => {
          const used = new Set<string>();
          return units.map((u) => {
            const liveRow = withLiveStart(u.unit, knownItems, used);
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
