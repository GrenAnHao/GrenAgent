import { afterEach, describe, expect, it, vi } from 'vitest';
import { Channel, getCurrentWebview, invoke, listen, openDirectory } from './runtime';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Electron runtime bridge', () => {
  it('forwards invoke and event subscriptions to preload', async () => {
    const unlisten = vi.fn();
    const subscribe = vi.fn(async (_event: string, handler: (event: { payload: string }) => void) => {
      handler({ payload: 'ready' });
      return unlisten;
    });
    const gren = {
      invoke: vi.fn(async () => ({ ok: true })),
      subscribe,
      pickDirectory: vi.fn(async () => 'C:/workspace'),
      openUrl: vi.fn(async () => {}),
      openPath: vi.fn(async () => {}),
      revealItemInDir: vi.fn(async () => {}),
      window: {},
      webview: {},
    };
    vi.stubGlobal('window', { gren });

    await expect(invoke<{ ok: boolean }>('ping', { value: 1 })).resolves.toEqual({ ok: true });
    const handler = vi.fn();
    await expect(listen('status', handler)).resolves.toBe(unlisten);
    expect(handler).toHaveBeenCalledWith({ payload: 'ready' });
    await expect(openDirectory()).resolves.toBe('C:/workspace');
    expect(subscribe).toHaveBeenCalledWith('status', handler);
  });

  it('keeps Channel compatible with callback-based callers', () => {
    const channel = new Channel<string>();
    const handler = vi.fn();
    channel.onmessage = handler;
    channel.postMessage('chunk');
    expect(handler).toHaveBeenCalledWith('chunk');
  });

  it('serializes Channel arguments and routes channel events back to the callback', async () => {
    const channel = new Channel<string>();
    const handler = vi.fn();
    channel.onmessage = handler;
    const subscribe = vi.fn(async (_event: string, listener: (event: { payload: string }) => void) => {
      listener({ payload: 'streamed' });
      return () => {};
    });
    const invokeSpy = vi.fn(async () => undefined);
    vi.stubGlobal('window', {
      gren: {
        invoke: invokeSpy,
        subscribe,
        pickDirectory: async () => null,
        openUrl: async () => {},
        openPath: async () => {},
        revealItemInDir: async () => {},
        window: {},
        webview: {},
      },
    });

    await invoke('diagnose', { onChunk: channel });
    expect(invokeSpy).toHaveBeenCalledWith('diagnose', { onChunk: { __grenChannelId: channel.id } });
    expect(subscribe).toHaveBeenCalledWith(`channel:${channel.id}`, expect.any(Function));
    expect(handler).toHaveBeenCalledWith('streamed');
  });

  it('exposes the webview event adapter', () => {
    const onDragDropEvent = vi.fn(async () => vi.fn());
    vi.stubGlobal('window', { gren: { webview: { onDragDropEvent } } });
    expect(getCurrentWebview().onDragDropEvent).toBe(onDragDropEvent);
  });

  it('keeps browser previews alive when Electron preload is absent', async () => {
    await expect(listen('pi://event', () => {})).resolves.toEqual(expect.any(Function));
  });
});
