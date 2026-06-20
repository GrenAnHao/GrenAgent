import { describe, expect, it, vi } from 'vitest';
import { buildActionItem } from './slots';
import type { MessageActionContext } from './types';

const ctx: MessageActionContext = { role: 'user', text: '你好世界' };

describe('buildActionItem', () => {
  it('copy 可用且点击写剪贴板并提示', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const success = vi.fn();
    const error = vi.fn();

    const item = buildActionItem('copy', ctx, { success, error });
    expect(item.key).toBe('copy');
    expect(item.disabled).toBeFalsy();
    expect(item.onClick).toBeTypeOf('function');

    await item.onClick!();
    expect(writeText).toHaveBeenCalledWith('你好世界');
    expect(success).toHaveBeenCalledWith('已复制');
    expect(error).not.toHaveBeenCalled();
  });

  it('copy 在无剪贴板 API 时提示失败', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const success = vi.fn();
    const error = vi.fn();

    const item = buildActionItem('copy', ctx, { success, error });
    await item.onClick!();

    expect(success).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('复制失败：当前环境不支持剪贴板');
  });

  it('copy 在 writeText 失败时提示失败', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const success = vi.fn();
    const error = vi.fn();

    const item = buildActionItem('copy', ctx, { success, error });
    await item.onClick!();

    expect(success).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('复制失败');
  });

  it('edit / regenerate / del 为 disabled 占位且无 onClick', () => {
    for (const slot of ['edit', 'regenerate', 'del'] as const) {
      const item = buildActionItem(slot, ctx, { success: vi.fn(), error: vi.fn() });
      expect(item.disabled).toBe(true);
      expect(item.onClick).toBeUndefined();
      expect(item.label).toContain('即将支持');
    }
  });
});
