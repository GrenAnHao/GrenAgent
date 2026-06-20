import { Copy, PencilLine, RotateCcw, Trash2 } from 'lucide-react';
import type { MessageActionContext, MessageActionItem, MessageActionKey, Notify } from './types';

const SOON = '即将支持';

/**
 * 解析单个 slot 为动作项。copy 为真实现（写剪贴板 + 提示）；
 * edit/regenerate/del 为 disabled 占位（Phase 2 接 pi fork 后填 onClick）。
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
    case 'edit':
      return { key: 'edit', icon: PencilLine, label: `编辑（${SOON}）`, disabled: true };
    case 'regenerate':
      return { key: 'regenerate', icon: RotateCcw, label: `重新生成（${SOON}）`, disabled: true };
    case 'del':
      return { key: 'del', icon: Trash2, label: `删除（${SOON}）`, disabled: true, danger: true };
  }
}
