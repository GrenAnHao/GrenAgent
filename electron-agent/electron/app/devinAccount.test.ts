import { describe, expect, it, vi } from 'vitest';
import { createDevinAccount, type DevinOAuthOpener, type DevinSessionPort } from './devinAccount';

function port(overrides: Partial<DevinSessionPort> = {}): DevinSessionPort {
  return {
    view: vi.fn(async () => ({ state: 'missing' as const })),
    login: vi.fn(async (_signal: AbortSignal, notify: (url: string) => void) => {
      notify('https://app.devin.ai/auth/cli/continue?state=1');
      return 'saved';
    }),
    logout: vi.fn(async () => 'cleared'),
    dispose: vi.fn(),
    ...overrides,
  };
}

function opener(): { open: DevinOAuthOpener; close: ReturnType<typeof vi.fn>; onClosed: (cb: () => void) => void } {
  let closed: () => void = () => {};
  const close = vi.fn();
  return {
    close,
    onClosed: (cb) => { closed = cb; },
    open: vi.fn(() => ({
      close,
      onClosed: (cb: () => void) => { closed = cb; },
    })),
  };
}

describe('createDevinAccount', () => {
  it('opens the OAuth window and returns a view with no token', async () => {
    const session = port({
      view: vi.fn(async () => ({ state: 'ok' as const, expiresAt: '2026-10-06T00:00:00.000Z', expirySource: 'fallback' as const })),
    });
    const window = opener();
    const view = await createDevinAccount(() => session).login(window.open);
    expect(window.open).toHaveBeenCalledWith('https://app.devin.ai/auth/cli/continue?state=1');
    expect(window.close).toHaveBeenCalled();
    expect(view).toEqual({ state: 'ok', expiresAt: '2026-10-06T00:00:00.000Z', expirySource: 'fallback' });
    expect(view).not.toHaveProperty('token');
    expect(session.dispose).toHaveBeenCalled();
  });

  it('shares one in-flight login', async () => {
    let opened = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const window = opener();
    const account = createDevinAccount(() => port({
      login: async (_signal, notify) => {
        opened += 1;
        notify('https://app.devin.ai/auth');
        await gate;
        return 'saved';
      },
      view: async () => ({ state: 'ok' }),
    }));
    const first = account.login(window.open);
    const second = account.login(window.open);
    release();
    await Promise.all([first, second]);
    expect(opened).toBe(1);
    expect(window.open).toHaveBeenCalledTimes(1);
  });

  it('cancels when the OAuth window is closed', async () => {
    let onClosed: () => void = () => {};
    const session = port({
      login: (signal, notify) => {
        notify('https://app.devin.ai/auth');
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    });
    const pending = createDevinAccount(() => session).login(() => ({
      close: vi.fn(),
      onClosed: (cb) => { onClosed = cb; },
    }));
    onClosed();
    await expect(pending).rejects.toThrow('登录已取消');
  });

  it('logout returns the cleared view', async () => {
    const session = port({ view: async () => ({ state: 'missing' }) });
    const view = await createDevinAccount(() => session).logout();
    expect(session.logout).toHaveBeenCalled();
    expect(view).toEqual({ state: 'missing' });
  });
});
