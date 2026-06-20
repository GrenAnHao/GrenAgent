import { memo, createElement } from 'react';
import { ActionIcon, Flexbox } from '@lobehub/ui';
import { App, Dropdown, type MenuProps } from 'antd';
import { MoreHorizontal } from 'lucide-react';
import { buildActionItem } from './slots';
import type { MessageActionContext, MessageActionSlot } from './types';

interface MessageActionBarProps {
  ctx: MessageActionContext;
  /** 常驻图标条的槽位（按显示顺序）。 */
  bar: MessageActionSlot[];
  /** `...` 溢出菜单的槽位；省略则不渲染更多按钮。 */
  menu?: MessageActionSlot[];
}

/** 通用消息操作栏：声明式 slot → ActionIcon 条 + Dropdown 溢出菜单。 */
export const MessageActionBar = memo<MessageActionBarProps>(({ ctx, bar, menu }) => {
  const { message } = App.useApp();
  const notify = { success: (c: string) => message.success(c) };

  const menuItems: MenuProps['items'] = menu?.map((slot, i) => {
    if (slot === 'divider') return { type: 'divider', key: `divider-${i}` };
    const it = buildActionItem(slot, ctx, notify);
    return {
      key: it.key,
      label: it.label,
      icon: createElement(it.icon, { size: 14 }),
      disabled: it.disabled,
      danger: it.danger,
      onClick: it.onClick,
    };
  });

  return (
    <Flexbox horizontal align="center" gap={2} role="menubar" data-testid="message-action-bar">
      {bar
        .filter((slot): slot is Exclude<MessageActionSlot, 'divider'> => slot !== 'divider')
        .map((slot) => {
          const it = buildActionItem(slot, ctx, notify);
          return (
            <ActionIcon
              key={it.key}
              icon={it.icon}
              size="small"
              title={it.label}
              aria-label={it.label}
              data-testid={`msg-action-bar-${it.key}`}
              disabled={it.disabled}
              onClick={it.onClick}
            />
          );
        })}
      {menuItems && menuItems.length > 0 && (
        <Dropdown menu={{ items: menuItems }} trigger={['click']}>
          <ActionIcon icon={MoreHorizontal} size="small" title="更多" aria-label="更多" />
        </Dropdown>
      )}
    </Flexbox>
  );
});

MessageActionBar.displayName = 'MessageActionBar';
