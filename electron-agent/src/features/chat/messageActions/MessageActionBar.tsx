import { memo, createElement, useMemo, type ReactNode } from 'react';
import { ActionIcon, Flexbox } from '@lobehub/ui';
import { App, Dropdown, type MenuProps } from 'antd';
import { MoreHorizontal } from 'lucide-react';
import { buildActionItem } from './slots';
import type { MessageActionContext, MessageActionSlot, Notify } from './types';
import { useOptionalAgentStoreContext } from '../../../stores/AgentStoreContext';
import type { AgentStoreApi } from '../../../stores/agent';
import type { ChatMessage } from '../../../stores/agentReducer';

/** 流式/等待响应中从 bar/menu 滤掉的槽位：编辑/重生成/删除会改写会话，等回合结束后再露出。 */
const HIDDEN_WHILE_BUSY = new Set<MessageActionSlot>(['edit', 'regenerate', 'del']);
/** 已移出上下文：不允许编辑/回退/重生成/删除。 */
const HIDDEN_WHEN_EXCLUDED = new Set<MessageActionSlot>(['edit', 'regenerate', 'del', 'rewind']);
/** 非当前上下文最后一条用户消息：隐藏编辑与重新生成。 */
const HIDDEN_WHEN_NOT_LAST = new Set<MessageActionSlot>(['edit', 'regenerate']);

function filterSlots(
  slots: MessageActionSlot[] | undefined,
  hide: Set<MessageActionSlot>,
): MessageActionSlot[] | undefined {
  if (!slots) return slots;
  return slots.filter((slot) => !hide.has(slot));
}

function matchesUserMessage(
  m: ChatMessage,
  entryId: string | undefined,
  timestamp: number | undefined,
): boolean {
  if (m.kind !== 'user') return false;
  if (entryId && m.entryId) return m.entryId === entryId;
  if (timestamp != null && m.timestamp != null) return m.timestamp === timestamp;
  return false;
}

function findLastInContextUserIndex(messages: ChatMessage[], excluded: Set<number>): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.kind !== 'user') continue;
    if (m.timestamp != null && excluded.has(m.timestamp)) continue;
    return i;
  }
  return -1;
}

function hasReplyAfter(messages: ChatMessage[], userIndex: number): boolean {
  for (let i = userIndex + 1; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.kind === 'user') return false;
    if (m.kind === 'assistant' || m.kind === 'tool') return true;
  }
  return false;
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

/** 有 store 上下文 + 消息带 timestamp 或 entryId：订阅 excluded，注入上下文动作回调。 */
function ContextBar({ ctx, bar, menu, store }: MessageActionBarProps & { store: AgentStoreApi }) {
  const notify = useNotify();
  const ts = ctx.timestamp;
  const excluded = store.useStore((s) => (ts != null ? s.excluded.has(ts) : false));
  // 流式/等待响应中仍渲染操作栏（回退/复制可用），但滤掉 edit/regenerate/del。
  const isBusy = store.useStore((s) => s.isStreaming || Boolean(s.awaitingResponse));
  const messages = store.useStore((s) => s.messages);
  const excludedSet = store.useStore((s) => s.excluded);

  const lastIdx = findLastInContextUserIndex(messages, excludedSet);
  const isLastInContext =
    lastIdx >= 0 && matchesUserMessage(messages[lastIdx]!, ctx.entryId, ctx.timestamp);
  const canRegenerate = isLastInContext && hasReplyAfter(messages, lastIdx);

  const enriched = useMemo<MessageActionContext>(
    () => ({
      ...ctx,
      excluded,
      // excluded 消息不注入改写类回调；非最后一条不注入 regenerate。
      onExclude:
        ts == null
          ? undefined
          : async (t) => {
              try {
                await store.excludeMessage(t);
              } catch {
                notify.error('移出上下文失败');
              }
            },
      onRestore:
        ts == null
          ? undefined
          : async (t) => {
              try {
                await store.restoreMessage(t);
              } catch {
                notify.error('恢复失败');
              }
            },
      onRewind: excluded
        ? undefined
        : async (entryId, text) => {
            try {
              await store.rewindAndLoad(entryId, text);
              notify.success('已回退到此');
            } catch {
              notify.error('回退失败');
            }
          },
      onRegenerate:
        excluded || !canRegenerate
          ? undefined
          : async (entryId, text, images) => {
              try {
                await store.regenerate(entryId, text, images);
              } catch {
                notify.error('重新生成失败');
              }
            },
      onDelete: excluded
        ? undefined
        : async (entryId) => {
            try {
              await store.deleteFrom(entryId);
              notify.success('已删除');
            } catch {
              notify.error('删除失败');
            }
          },
      // excluded / 非最后一条：去掉上游 onEdit，避免菜单里仍可点。
      onEdit: excluded || !isLastInContext ? undefined : ctx.onEdit,
    }),
    [ctx, excluded, store, notify, ts, canRegenerate, isLastInContext],
  );

  let visibleBar = bar;
  let visibleMenu = menu;
  if (excluded) {
    visibleBar = filterSlots(visibleBar, HIDDEN_WHEN_EXCLUDED) ?? visibleBar;
    visibleMenu = filterSlots(visibleMenu, HIDDEN_WHEN_EXCLUDED);
  } else if (!isLastInContext) {
    visibleBar = filterSlots(visibleBar, HIDDEN_WHEN_NOT_LAST) ?? visibleBar;
    visibleMenu = filterSlots(visibleMenu, HIDDEN_WHEN_NOT_LAST);
  }
  if (isBusy) {
    visibleBar = filterSlots(visibleBar, HIDDEN_WHILE_BUSY) ?? visibleBar;
    visibleMenu = filterSlots(visibleMenu, HIDDEN_WHILE_BUSY);
  }
  // 最后一条但尚无回复：隐藏重新生成（编辑仍可，若对话已停）。
  if (!excluded && isLastInContext && !canRegenerate) {
    const hideRegen = new Set<MessageActionSlot>(['regenerate']);
    visibleBar = filterSlots(visibleBar, hideRegen) ?? visibleBar;
    visibleMenu = filterSlots(visibleMenu, hideRegen);
  }

  return renderActions(enriched, visibleBar, visibleMenu, notify);
}

/** 无 store 上下文（如子代理对话）或缺定位键：仅渲染基础动作（copy 等）。 */
function PlainBar({ ctx, bar, menu }: MessageActionBarProps) {
  const notify = useNotify();
  return renderActions(ctx, bar, menu, notify);
}

/**
 * 通用消息操作栏。主对话（有 AgentStoreProvider）且消息带 timestamp 或 entryId 时启用上下文控制动作；
 * 其余场景降级为基础动作，保证子代理对话等无 store 环境也能安全渲染。
 */
export const MessageActionBar = memo<MessageActionBarProps>((props) => {
  const storeCtx = useOptionalAgentStoreContext();
  if (storeCtx && (props.ctx.timestamp != null || props.ctx.entryId)) {
    return <ContextBar {...props} store={storeCtx.store} />;
  }
  return <PlainBar {...props} />;
});

MessageActionBar.displayName = 'MessageActionBar';
