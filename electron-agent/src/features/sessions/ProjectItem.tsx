import { Dropdown } from 'antd';
import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { ChevronDown, ChevronRight, FolderClosed, FolderOpen, GitBranch } from 'lucide-react';
import { RowActions } from './RowActions';
import { buildProjectMenuItems } from './useProjectMenu';

const styles = createStaticStyles(({ css }) => ({
  row: css`
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    margin: 0 6px;
    padding: 0 8px 0 10px;
    border-radius: 7px;
    color: ${cssVar.colorText};
    cursor: pointer;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  car: css`
    display: inline-flex;
    color: ${cssVar.colorTextQuaternary};
  `,
  name: css`
    overflow: hidden;
    flex: 1;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  nested: css`
    padding-left: 26px;
  `,
  gone: css`
    color: ${cssVar.colorTextTertiary};
  `,
  tag: css`
    flex: none;
    padding: 0 5px;
    border-radius: 4px;
    background: ${cssVar.colorFillTertiary};
    color: ${cssVar.colorTextTertiary};
    font-size: 11px;
    line-height: 16px;
  `,
  acts: css`
    display: none;

    .pi-proj-row:hover & {
      display: flex;
    }
  `,
}));

export interface ProjectItemProps {
  name: string;
  expanded: boolean;
  pinned: boolean;
  onToggle: () => void;
  onNew: () => void;
  onPinToggle: () => void;
  onReveal: () => void;
  onRename: () => void;
  onHide: () => void;
  onClearSessions: () => void;
  onRemove: () => void;
  /** 独立工作区：缩进挂在父项目下、分支图标、「独立」标签；missing 时标「已删除」且不能新建会话。 */
  isolated?: { nested: boolean; missing: boolean };
  onNewIsolated?: () => void;
  onManageIsolated?: () => void;
  onSyncBack?: () => void;
  onDeleteIsolated?: () => void;
}

export function ProjectItem(p: ProjectItemProps) {
  const items = buildProjectMenuItems({
    pinned: p.pinned,
    onPinToggle: p.onPinToggle,
    onReveal: p.onReveal,
    onRename: p.onRename,
    onHide: p.onHide,
    onClearSessions: p.onClearSessions,
    onRemove: p.onRemove,
    ...(p.onNewIsolated ? { onNewIsolated: p.onNewIsolated } : {}),
    ...(p.onManageIsolated ? { onManageIsolated: p.onManageIsolated } : {}),
    ...(p.onSyncBack ? { onSyncBack: p.onSyncBack } : {}),
    ...(p.onDeleteIsolated ? { onDeleteIsolated: p.onDeleteIsolated } : {}),
  });
  const iso = p.isolated;

  return (
    <Dropdown menu={{ items }} trigger={['contextMenu']}>
      <div
        className={cx('pi-proj-row', styles.row, iso?.nested && styles.nested, iso?.missing && styles.gone)}
        data-testid={iso ? 'isolated-project-row' : 'project-row'}
        data-isolated-missing={iso?.missing ? 'true' : undefined}
        onClick={p.onToggle}
      >
        <span className={styles.car}>
          <Icon icon={p.expanded ? ChevronDown : ChevronRight} size="small" />
        </span>
        <Icon icon={iso ? GitBranch : p.expanded ? FolderOpen : FolderClosed} size="small" />
        <span className={styles.name}>{p.name}</span>
        {iso ? (
          <span className={styles.tag} title={iso.missing ? '目录已删除，会话只能查看' : '独立工作区：不能写主仓'}>
            {iso.missing ? '已删除' : '独立'}
          </span>
        ) : null}
        <span className={styles.acts}>
          <RowActions menuItems={items} {...(iso?.missing ? {} : { onNew: p.onNew })} />
        </span>
      </div>
    </Dropdown>
  );
}
