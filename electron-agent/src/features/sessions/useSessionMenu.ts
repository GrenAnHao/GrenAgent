import type { MenuProps } from 'antd';
import { createElement } from 'react';
import { Icon } from '@lobehub/ui';
import { FolderOpen, PencilLine, Pin, PinOff, Trash2 } from 'lucide-react';

export interface SessionMenuParams {
  pinned: boolean;
  onPinToggle: () => void;
  onRename: () => void;
  onDelete: () => void;
  /** 在系统资源管理器中打开该会话/对话的工作区目录（cwd）。未提供则不显示该项。 */
  onReveal?: () => void;
}

type Items = NonNullable<MenuProps['items']>;

export function buildSessionMenuItems(p: SessionMenuParams): Items {
  return [
    {
      key: 'pin',
      icon: createElement(Icon, { icon: p.pinned ? PinOff : Pin, size: 'small' }),
      label: p.pinned ? '取消置顶' : '置顶',
      onClick: p.onPinToggle,
    },
    ...(p.onReveal
      ? [
          {
            key: 'reveal',
            icon: createElement(Icon, { icon: FolderOpen, size: 'small' }),
            label: '在资源管理器中打开',
            onClick: p.onReveal,
          },
        ]
      : []),
    {
      key: 'rename',
      icon: createElement(Icon, { icon: PencilLine, size: 'small' }),
      label: '重命名',
      onClick: p.onRename,
    },
    { type: 'divider' },
    {
      key: 'delete',
      icon: createElement(Icon, { icon: Trash2, size: 'small' }),
      label: '删除',
      danger: true,
      onClick: p.onDelete,
    },
  ];
}

export const useSessionMenu = (p: SessionMenuParams): Items => buildSessionMenuItems(p);
