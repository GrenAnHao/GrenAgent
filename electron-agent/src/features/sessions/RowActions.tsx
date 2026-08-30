import type { MenuProps } from 'antd';
import { Dropdown } from 'antd';
import { ActionIcon } from '@lobehub/ui';
import { MoreHorizontal, SquarePen } from 'lucide-react';

interface RowActionsProps {
  menuItems: NonNullable<MenuProps['items']>;
  /** 提供则显示"在此项目新建会话"快捷按钮 */
  onNew?: () => void;
}

/** 行尾通用操作：可选「新建」+ 「⋯」下拉菜单。点击不冒泡到行本身。 */
export function RowActions({ menuItems, onNew }: RowActionsProps) {
  return (
    <span
      style={{ display: 'flex', gap: 2, alignItems: 'center' }}
      onClick={(e) => e.stopPropagation()}
    >
      {onNew && (
        <ActionIcon icon={SquarePen} size="small" title="在此项目新建会话" onClick={onNew} />
      )}
      <Dropdown menu={{ items: menuItems }} trigger={['click']}>
        <ActionIcon icon={MoreHorizontal} size="small" title="更多" />
      </Dropdown>
    </span>
  );
}
