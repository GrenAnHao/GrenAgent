import { memo, useCallback, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { SidebarSectionId } from '../../stores/sidebarPrefsStore';
import { useGroupAttention } from '../../stores/sessionAttention';
import { AttentionIcon } from './AttentionIcon';

const styles = createStaticStyles(({ css }) => ({
  row: css`
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 8px 8px 0 6px;
  `,
  toggle: css`
    display: flex;
    flex: 1;
    align-items: center;
    gap: 2px;
    min-width: 0;
    height: 28px;
    padding: 0 8px;
    border-radius: 6px;
    color: ${cssVar.colorTextTertiary};
    cursor: pointer;
    user-select: none;
    outline: none;

    &:hover {
      color: ${cssVar.colorTextSecondary};
    }

    &:focus-visible {
      box-shadow: inset 0 0 0 1px ${cssVar.colorPrimaryBorder};
    }
  `,
  label: css`
    overflow: hidden;
    font-size: 11px;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  // 展开时箭头只在悬停 / 键盘聚焦时出现，平时区头和原来一样干净；收起时一直显示，看得出这一区被收起了。
  // 用 :focus-visible 不用 :focus-within：鼠标点过之后焦点还留在区头上，箭头不该一直挂着。
  caret: css`
    display: inline-flex;
    flex: none;
    color: ${cssVar.colorTextQuaternary};
    opacity: 0;
    transition: opacity 0.15s;

    .pi-sidebar-section[data-collapsed='true'] &,
    .pi-sidebar-section:hover &,
    .pi-sidebar-section:has(:focus-visible) & {
      opacity: 1;
    }
  `,
  /* 收起时区里会话的注意状态汇总，和折叠的项目分组头一样。 */
  attention: css`
    display: inline-flex;
    flex: none;
    gap: 3px;
    align-items: center;
    margin-inline-start: 4px;
  `,
  count: css`
    color: ${cssVar.colorTextSecondary};
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    line-height: 16px;
  `,
}));

const NO_PATHS: readonly string[] = [];
const NO_RUNNING: ReadonlySet<string> = new Set();

export interface SidebarSectionHeaderProps {
  id: SidebarSectionId;
  label: string;
  collapsed: boolean;
  onToggle: (id: SidebarSectionId) => void;
  /** 区头右侧的新建入口；它是兄弟节点，点它不会折叠 / 展开。 */
  action?: ReactNode;
  /** 收起时藏起来的会话路径和侧栏的运行中集合，用来画注意状态汇总。 */
  sessionPaths?: readonly string[];
  runningSessionPaths?: ReadonlySet<string>;
}

/** 侧栏最顶层分区（置顶 / 对话 / 项目）的区头：点标题折叠 / 展开整区。 */
export const SidebarSectionHeader = memo(function SidebarSectionHeader({
  id,
  label,
  collapsed,
  onToggle,
  action,
  sessionPaths,
  runningSessionPaths,
}: SidebarSectionHeaderProps) {
  const attention = useGroupAttention(
    sessionPaths ?? NO_PATHS,
    runningSessionPaths ?? NO_RUNNING,
    collapsed && Boolean(sessionPaths?.length),
  );
  const handleToggle = useCallback(() => onToggle(id), [onToggle, id]);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onToggle(id);
    },
    [onToggle, id],
  );

  return (
    <div
      className={`pi-sidebar-section ${styles.row}`}
      data-testid="sidebar-section"
      data-section={id}
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        title={collapsed ? `展开${label}` : `收起${label}`}
        className={styles.toggle}
        data-testid="sidebar-section-toggle"
        onClick={handleToggle}
        onKeyDown={handleKeyDown}
      >
        <span className={styles.label}>{label}</span>
        <span className={styles.caret} data-testid="sidebar-section-caret">
          <Icon icon={collapsed ? ChevronRight : ChevronDown} size={12} />
        </span>
        {collapsed && attention ? (
          <span className={styles.attention} data-testid="sidebar-section-attention" data-kind={attention.kind}>
            <AttentionIcon kind={attention.kind} />
            {attention.count > 0 ? (
              <span className={styles.count} data-testid="sidebar-section-attention-count">
                {attention.count}
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      {action}
    </div>
  );
});
