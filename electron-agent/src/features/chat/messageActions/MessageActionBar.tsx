import { memo, createElement, useMemo, type ReactNode } from 'react';
import { ActionIcon, Flexbox } from '@lobehub/ui';
import { App, Dropdown, type MenuProps } from 'antd';
import { MoreHorizontal } from 'lucide-react';
import { buildActionItem } from './slots';
import type { MessageActionContext, MessageActionSlot, Notify } from './types';
import { useOptionalAgentStoreContext } from '../../../stores/AgentStoreContext';
import type { AgentStoreApi } from '../../../stores/agent';

/** 流式进行中从 bar/menu 滤掉的槽位：编辑/重生成/删除会改写会话，等回合结束后再露出。 */
const HIDDEN_WHILE_STREAMING = new Set<MessageActionSlot>(['edit', 'regenerate', 'del']);

function filterStreamingSlots(slots: MessageActionSlot[]): MessageActionSlot[];
function filterStreamingSlots(slots: MessageActionSlot[] | undefined): MessageActionSlot[] | undefined;
function filterStreamingSlots(slots: MessageActionSlot[] | undefined): MessageActionSlot[] | undefined {
  if (!slots) return slots;
  return slots.filter((slot) => !HIDDEN_WHILE_STREAMING.has(slot));
}

interface MessageActionBarProps {
  ctx: MessageActionContext;
  /** 常驻图标条的槽位（按显示顺序）。 */
  bar: MessageActionSlot[];
  /** `...` 溢出菜单的槽位；省略则不渲染更多按钮。 */
  menu?: MessageActionSlot[];
}

/** 声明式 slot → ActionIcon 条 + Dropdown 溢出菜单（纯渲染，ctx 已就绪）。 */
function renderActions(
  ctx: MessageActionContext,
  bar: MessageActionSlot[],
  menu: MessageActionSlot[] | undefined,
  notify: Notify,
): ReactNode {
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
}

function useNotify(): Notify {
  const { message } = App.useApp();
  return useMemo(
    () => ({ success: (c: string) => message.success(c), error: (c: string) => message.error(c) }),
    [message],
  );
}

/** 有 store 上下文 + 消息带 timestamp：订阅 excluded 灰显态，注入移出/恢复/回退回调。 */
function ContextBar({ ctx, bar, menu, store }: MessageActionBarProps & { store: AgentStoreApi }) {
  const notify = useNotify();
  const ts = ctx.timestamp as number; // 外层已保证 != null
  const excluded = store.useStore((s) => s.excluded.has(ts));
  // 流式进行中仍渲染操作栏（回退/复制可用），但滤掉 edit/regenerate/del，避免与进行中的回合抢状态。
  const isStreaming = store.useStore((s) => s.isStreaming);
  const enriched = useMemo<MessageActionContext>(
    () => ({
      ...ctx,
      excluded,
      onExclude: async (t) => {
        try {
          await store.excludeMessage(t);
        } catch {
          notify.error('移出上下文失败');
        }
      },
      onRestore: async (t) => {
        try {
          await store.restoreMessage(t);
        } catch {
          notify.error('恢复失败');
        }
      },
      onRewind: async (entryId, text) => {
        try {
          await store.rewindAndLoad(entryId, text);
          notify.success('已回退到此');
        } catch {
          notify.error('回退失败');
        }
      },
      onRegenerate: async (entryId, text, images) => {
        try {
          await store.regenerate(entryId, text, images);
        } catch {
          notify.error('重新生成失败');
        }
      },
      onDelete: async (entryId) => {
        try {
          await store.deleteFrom(entryId);
          notify.success('已删除');
        } catch {
          notify.error('删除失败');
        }
      },
    }),
    [ctx, excluded, store, notify],
  );
  const visibleBar = isStreaming ? filterStreamingSlots(bar) : bar;
  const visibleMenu = isStreaming ? filterStreamingSlots(menu) : menu;
  return renderActions(enriched, visibleBar, visibleMenu, notify);
}

/** 无 store 上下文（如子代理对话）或消息无 timestamp：仅渲染基础动作（copy 等）。 */
function PlainBar({ ctx, bar, menu }: MessageActionBarProps) {
  const notify = useNotify();
  return renderActions(ctx, bar, menu, notify);
}

/**
 * 通用消息操作栏。主对话（有 AgentStoreProvider）且消息带 timestamp 时启用上下文控制动作；
 * 其余场景降级为基础动作，保证子代理对话等无 store 环境也能安全渲染。
 */
export const MessageActionBar = memo<MessageActionBarProps>((props) => {
  const storeCtx = useOptionalAgentStoreContext();
  if (storeCtx && props.ctx.timestamp != null) {
    return <ContextBar {...props} store={storeCtx.store} />;
  }
  return <PlainBar {...props} />;
});

MessageActionBar.displayName = 'MessageActionBar';
