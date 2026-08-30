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

  const notify = { success: vi.fn(), error: vi.fn() };

  it('exclude：未排除 + 带 timestamp/onExclude → 「移出上下文」可点击', () => {
    const onExclude = vi.fn();
    const item = buildActionItem(
      'exclude',
      { role: 'user', text: 'x', timestamp: 50, onExclude },
      notify,
    );
    expect(item.label).toBe('移出上下文');
    expect(item.disabled).toBe(false);
    item.onClick!();
    expect(onExclude).toHaveBeenCalledWith(50);
  });

  it('exclude：已排除 → 「恢复到上下文」，点击调 onRestore', () => {
    const onRestore = vi.fn();
    const item = buildActionItem(
      'exclude',
      { role: 'user', text: 'x', timestamp: 50, excluded: true, onRestore },
      notify,
    );
    expect(item.label).toBe('恢复到上下文');
    item.onClick!();
    expect(onRestore).toHaveBeenCalledWith(50);
  });

  it('exclude：无 timestamp → 禁用且无 onClick', () => {
    const item = buildActionItem('exclude', { role: 'user', text: 'x' }, notify);
    expect(item.disabled).toBe(true);
    expect(item.onClick).toBeUndefined();
  });

  it('rewind：带 timestamp/onRewind 可点击，缺失则禁用', () => {
    const onRewind = vi.fn();
    const ok = buildActionItem(
      'rewind',
      { role: 'user', text: 'x', timestamp: 9, onRewind },
      notify,
    );
    expect(ok.label).toBe('回退到此');
    expect(ok.disabled).toBe(false);
    ok.onClick!();
    expect(onRewind).toHaveBeenCalledWith(9);

    const disabled = buildActionItem('rewind', { role: 'user', text: 'x' }, notify);
    expect(disabled.disabled).toBe(true);
    expect(disabled.onClick).toBeUndefined();
  });
});
