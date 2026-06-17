import { Dropdown } from 'antd';
import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { ChevronDown, ChevronRight, FolderClosed, FolderOpen } from 'lucide-react';
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
    font-size: 13px;
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
  badge: css`
    padding: 0 5px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 4px;
    color: ${cssVar.colorTextTertiary};
    font-size: 10px;
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
  isCurrent: boolean;
  pinned: boolean;
  onToggle: () => void;
  onNew: () => void;
  onPinToggle: () => void;
  onReveal: () => void;
  onRename: () => void;
  onHide: () => void;
  onRemove: () => void;
}

export function ProjectItem(p: ProjectItemProps) {
  const items = buildProjectMenuItems({
    pinned: p.pinned,
    onPinToggle: p.onPinToggle,
    onReveal: p.onReveal,
    onRename: p.onRename,
    onHide: p.onHide,
    onRemove: p.onRemove,
  });

  return (
    <Dropdown menu={{ items }} trigger={['contextMenu']}>
      <div className={cx('pi-proj-row', styles.row)} onClick={p.onToggle}>
        <span className={styles.car}>
          <Icon icon={p.expanded ? ChevronDown : ChevronRight} size="small" />
        </span>
        <Icon icon={p.expanded ? FolderOpen : FolderClosed} size="small" />
        <span className={styles.name}>{p.name}</span>
        {p.isCurrent && <span className={styles.badge}>当前</span>}
        <span className={styles.acts}>
          <RowActions menuItems={items} onNew={p.onNew} />
        </span>
      </div>
    </Dropdown>
  );
}
