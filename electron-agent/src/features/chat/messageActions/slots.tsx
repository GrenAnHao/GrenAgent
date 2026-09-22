import { Copy, Eye, EyeOff, PencilLine, RotateCcw, Trash2, Undo2 } from 'lucide-react';
import type { MessageActionContext, MessageActionItem, MessageActionKey, Notify } from './types';

/**
 * 解析单个 slot 为动作项。copy 为真实现（写剪贴板 + 提示）；
 * exclude（移出/恢复上下文）、rewind（回退到此）在有 store 上下文且消息带 timestamp 时可用，
 * 由 MessageActionBar 注入回调；否则禁用。regenerate/del 在有 entryId + 回调时启用；
 * edit 在有 onEdit 时启用。
 */
export function buildActionItem(
  slot: MessageActionKey,
  ctx: MessageActionContext,
  notify: Notify,
): MessageActionItem {
  switch (slot) {
    case 'copy':
      return {
        key: 'copy',
        icon: Copy,
        label: '复制',
        onClick: async () => {
          if (!navigator.clipboard?.writeText) {
            notify.error('复制失败：当前环境不支持剪贴板');
            return;
          }
          try {
            await navigator.clipboard.writeText(ctx.text);
            notify.success('已复制');
          } catch {
            notify.error('复制失败');
          }
        },
      };
    case 'edit': {
      const handler = ctx.onEdit;
      return {
        key: 'edit',
        icon: PencilLine,
        label: '编辑',
        disabled: !handler,
        onClick: handler,
      };
    }
    case 'regenerate': {
      const entryId = ctx.entryId;
      const handler = ctx.onRegenerate;
      return {
        key: 'regenerate',
        icon: RotateCcw,
        label: '重新生成',
        disabled: !entryId || !handler,
        onClick:
          entryId && handler
            ? () => {
                void handler(entryId, ctx.text, ctx.images);
              }
            : undefined,
      };
    }
    case 'del': {
      const entryId = ctx.entryId;
      const handler = ctx.onDelete;
      return {
        key: 'del',
        icon: Trash2,
        label: '删除',
        disabled: !entryId || !handler,
        danger: true,
        onClick:
          entryId && handler
            ? () => {
                if (!window.confirm('确认删除这条消息及其后的内容？')) return;
                void handler(entryId);
              }
            : undefined,
      };
    }
    case 'exclude': {
      const ts = ctx.timestamp;
      const excluded = Boolean(ctx.excluded);
      const handler = excluded ? ctx.onRestore : ctx.onExclude;
      return {
        key: 'exclude',
        icon: excluded ? Eye : EyeOff,
        label: excluded ? '恢复到上下文' : '移出上下文',
        disabled: ts == null || !handler,
        onClick: ts != null && handler ? () => handler(ts) : undefined,
      };
    }
    case 'rewind': {
      const entryId = ctx.entryId;
      const handler = ctx.onRewind;
      return {
        key: 'rewind',
        icon: Undo2,
        label: '回退到此',
        disabled: !entryId || !handler,
        onClick:
          entryId && handler
            ? () => {
                if (!window.confirm('确认回退到此？该条及其后的内容将被删除，原文会放入输入框。')) return;
                void handler(entryId, ctx.text);
              }
            : undefined,
      };
    }
  }
}
