import { ActionIcon, Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import {
  CheckCircle2,
  CircleDashed,
  CircleStop,
  GitBranch,
  Loader2,
  PanelRightOpen,
  Rows3,
  XCircle,
} from 'lucide-react';
import { memo, type MouseEvent } from 'react';
import { cardStyles } from '../tools/cardStyles';
import type { SubAgentMode, SubAgentUnit, SubAgentUnitStatus } from '../panels/subagentUtils';
import { useDockStore } from '../../stores/dockStore';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { pi } from '../../lib/pi';

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

function statusMeta(status: SubAgentUnitStatus) {
  switch (status) {
    case 'running':
      return { icon: Loader2, color: cssVar.colorTextSecondary, spin: true, label: '运行中…' };
    case 'done':
      return { icon: CheckCircle2, color: cssVar.colorSuccess, spin: false, label: '已完成' };
    case 'error':
      return { icon: XCircle, color: cssVar.colorError, spin: false, label: '出错' };
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
  const { workspace } = useAgentStoreContext();
  const running = status === 'running';
  // 组头成败汇总：非运行态时统计失败子代理数（与工具聚合一致，部分失败用琥珀计数而非整组标红）。
  const errorCount = units.filter((u) => u.unit.status === 'error').length;

  const open = (u: NumberedUnit) => {
    useDockStore.getState().openSubAgent({
      messageId,
      toolCallId,
      subIndex: u.unit.subIndex,
      title: `#${u.no} ${u.unit.task}`,
    });
  };

  const stop = (e: MouseEvent) => {
    e.stopPropagation();
    void pi.abort(workspace);
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
        {units.map((u) => {
          const sm = statusMeta(u.unit.status);
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
              <span className={cx(styles.task, u.unit.status === 'running' && card.shinyText)}>{u.unit.task}</span>
              <span className={styles.badge}>{sm.label}</span>
              <ActionIcon icon={PanelRightOpen} size="small" title="在右侧面板打开" onClick={(e) => { e.stopPropagation(); open(u); }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const SubAgentGroupInline = memo(SubAgentGroupInlineInner);
