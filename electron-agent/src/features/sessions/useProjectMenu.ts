import type { MenuProps } from 'antd';
import { createElement } from 'react';
import { Icon } from '@lobehub/ui';
import { ArrowUpFromLine, EyeOff, FolderOpen, GitBranch, GitBranchPlus, PencilLine, Pin, PinOff, Trash2 } from 'lucide-react';

export interface ProjectMenuParams {
  pinned: boolean;
  onPinToggle: () => void;
  onReveal: () => void; // 在资源管理器中打开
  onRename: () => void; // 重命名（别名）
  onHide: () => void; // 从列表隐藏
  onClearSessions: () => void; // 清空该项目全部会话，项目留在侧栏
  onRemove: () => void; // 移除项目（清空会话并从列表拿掉，不删真实目录）
  /** 普通项目：在独立工作区中新建会话、管理独立工作区。 */
  onNewIsolated?: () => void;
  onManageIsolated?: () => void;
  /** 独立工作区本身：回传分支、删除（走管理弹窗，带二次确认）。 */
  onSyncBack?: () => void;
  onDeleteIsolated?: () => void;
}

type Items = NonNullable<MenuProps['items']>;

function isolatedItems(p: ProjectMenuParams): Items {
  const items: Items = [];
  if (p.onNewIsolated) {
    items.push({
      key: 'isolated-new',
      icon: createElement(Icon, { icon: GitBranchPlus, size: 'small' }),
      label: '在独立工作区中新建会话…',
      onClick: p.onNewIsolated,
    });
  }
  if (p.onSyncBack) {
    items.push({
      key: 'isolated-sync-back',
      icon: createElement(Icon, { icon: ArrowUpFromLine, size: 'small' }),
      label: '回传分支到主仓',
      onClick: p.onSyncBack,
    });
  }
  if (p.onManageIsolated) {
    items.push({
      key: 'isolated-manage',
      icon: createElement(Icon, { icon: GitBranch, size: 'small' }),
      label: '管理独立工作区…',
      onClick: p.onManageIsolated,
    });
  }
  if (p.onDeleteIsolated) {
    items.push({
      key: 'isolated-delete',
      icon: createElement(Icon, { icon: Trash2, size: 'small' }),
      label: '删除独立工作区…',
      danger: true,
      onClick: p.onDeleteIsolated,
    });
  }
  return items.length ? [...items, { type: 'divider' }] : items;
}

export function buildProjectMenuItems(p: ProjectMenuParams): Items {
  return [
    ...isolatedItems(p),
    {
      key: 'pin',
      icon: createElement(Icon, { icon: p.pinned ? PinOff : Pin, size: 'small' }),
      label: p.pinned ? '取消置顶项目' : '置顶项目',
      onClick: p.onPinToggle,
    },
    {
      key: 'reveal',
      icon: createElement(Icon, { icon: FolderOpen, size: 'small' }),
      label: '在资源管理器中打开',
      onClick: p.onReveal,
    },
    {
      key: 'rename',
      icon: createElement(Icon, { icon: PencilLine, size: 'small' }),
      label: '重命名（别名）',
      onClick: p.onRename,
    },
    { type: 'divider' },
    {
      key: 'hide',
      icon: createElement(Icon, { icon: EyeOff, size: 'small' }),
      label: '从列表隐藏',
      onClick: p.onHide,
    },
    {
      key: 'clear-sessions',
      icon: createElement(Icon, { icon: Trash2, size: 'small' }),
      label: '清空会话',
      danger: true,
      onClick: p.onClearSessions,
    },
    {
      key: 'remove',
      icon: createElement(Icon, { icon: Trash2, size: 'small' }),
      label: '移除项目',
      danger: true,
      onClick: p.onRemove,
    },
  ];
}

export const useProjectMenu = (p: ProjectMenuParams): Items => buildProjectMenuItems(p);
