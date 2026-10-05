import { describe, expect, it, vi } from 'vitest';
import { WebviewGuestRegistry } from './webviewGuestRegistry';

function guest(partial: { id: number; type?: string; destroyed?: boolean }) {
  return {
    id: partial.id,
    getType: () => partial.type ?? 'webview',
    isDestroyed: () => partial.destroyed === true,
    once: vi.fn(),
  };
}

describe('WebviewGuestRegistry', () => {
  it('maps a live webview guest to a tab id', () => {
    const registry = new WebviewGuestRegistry();
    expect(registry.attach('tab-1', guest({ id: 42 }))).toEqual({ ok: true });
    expect(registry.tabIdFor(42)).toBe('tab-1');
  });

  it('rejects non-webview and destroyed guests', () => {
    const registry = new WebviewGuestRegistry();
    expect(registry.attach('tab-1', guest({ id: 1, type: 'window' }))).toEqual({ ok: false });
    expect(registry.attach('tab-1', guest({ id: 2, destroyed: true }))).toEqual({ ok: false });
    expect(registry.tabIdFor(1)).toBeUndefined();
  });

  it('clears on detach and on destroyed', () => {
    const registry = new WebviewGuestRegistry();
    const view = guest({ id: 7 });
    registry.attach('tab-7', view);
    registry.detach('tab-7');
    expect(registry.tabIdFor(7)).toBeUndefined();

    registry.attach('tab-8', view);
    // 同一 guest 二次 attach 会在 mock 上再注册一个 destroyed 回调，必须取最近注册的那个。
    const destroyed = view.once.mock.calls.at(-1)?.[1] as (() => void) | undefined;
    expect(destroyed).toBeTypeOf('function');
    expect(registry.tabIdFor(7)).toBe('tab-8');
    destroyed?.();
    expect(registry.tabIdFor(7)).toBeUndefined();
  });

  it('stale destroyed handler does not clear a newer mapping', () => {
    const registry = new WebviewGuestRegistry();
    const view = guest({ id: 7 });
    registry.attach('tab-7', view);
    const stale = view.once.mock.calls[0]?.[1] as (() => void);
    registry.attach('tab-8', view);
    expect(registry.tabIdFor(7)).toBe('tab-8');
    stale();
    expect(registry.tabIdFor(7)).toBe('tab-8');
  });
});
