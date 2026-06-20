import { describe, expect, it, vi } from 'vitest';
import { buildActionItem } from './slots';
import type { MessageActionContext } from './types';

const ctx: MessageActionContext = { role: 'user', text: '你好世界' };

describe('buildActionItem', () => {
  it('copy 可用且点击写剪贴板并提示', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const success = vi.fn();

    const item = buildActionItem('copy', ctx, { success });
    expect(item.key).toBe('copy');
    expect(item.disabled).toBeFalsy();
    expect(item.onClick).toBeTypeOf('function');

    await item.onClick!();
    expect(writeText).toHaveBeenCalledWith('你好世界');
    expect(success).toHaveBeenCalledWith('已复制');
  });

  it('edit / regenerate / del 为 disabled 占位且无 onClick', () => {
    for (const slot of ['edit', 'regenerate', 'del'] as const) {
      const item = buildActionItem(slot, ctx, { success: vi.fn() });
      expect(item.disabled).toBe(true);
      expect(item.onClick).toBeUndefined();
      expect(item.label).toContain('即将支持');
    }
  });
});
