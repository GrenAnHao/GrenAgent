import type { MenuProps } from 'antd';
import { createElement } from 'react';
import { Icon } from '@lobehub/ui';
import { Archive, FolderOpen, PencilLine, Pin, PinOff, Sparkles, Trash2 } from 'lucide-react';

export interface SessionMenuParams {
  pinned: boolean;
  onPinToggle: () => void;
  onRename: () => void;
  /** 按第一条消息重新生成标题。未提供则不显示该项。 */
  onRegenerateTitle?: () => void;
  onDelete: () => void;
  /** 在系统资源管理器中打开该会话/对话的工作区目录（cwd）。未提供则不显示该项。 */
  onReveal?: () => void;
  /** 归档：从侧栏拿走、文件保留。未提供则不显示该项。 */
  onArchive?: () => void;
  /** 回合还在跑：归档置灰，免得会话在后台跑着、侧栏却没有入口。 */
  archiveDisabled?: boolean;
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
    ...(p.onRegenerateTitle
      ? [
          {
            key: 'regenerate-title',
            icon: createElement(Icon, { icon: Sparkles, size: 'small' }),
            label: '重新生成标题',
            onClick: p.onRegenerateTitle,
          },
        ]
      : []),
    ...(p.onArchive
      ? [
          {
            key: 'archive',
            icon: createElement(Icon, { icon: Archive, size: 'small' }),
            label: p.archiveDisabled ? '归档（运行中不可用）' : '归档',
            disabled: p.archiveDisabled,
            onClick: p.onArchive,
          },
        ]
      : []),
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
