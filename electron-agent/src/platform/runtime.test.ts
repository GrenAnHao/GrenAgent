import { afterEach, describe, expect, it, vi } from 'vitest';
import { Channel, getCurrentWebview, invoke, listen, openDirectory, openFile } from './runtime';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Electron runtime bridge', () => {
  it('opens a filtered file and preserves cancellation from preload', async () => {
    const pickFile = vi.fn().mockResolvedValueOnce('C:/skills/example.zip').mockResolvedValueOnce(null);
    vi.stubGlobal('window', { gren: { pickFile } });
    await expect(openFile({ filters: [{ name: 'Zip', extensions: ['zip'] }] })).resolves.toBe('C:/skills/example.zip');
    expect(pickFile).toHaveBeenCalledWith({ filters: [{ name: 'Zip', extensions: ['zip'] }] });
    await expect(openFile()).resolves.toBeNull();
  });

  it('rejects a missing file picker instead of selecting a directory', async () => {
    const pickDirectory = vi.fn().mockResolvedValue('C:/skills');
    vi.stubGlobal('window', { gren: { pickDirectory } });
    await expect(openFile()).rejects.toThrow('不支持文件选择');
    expect(pickDirectory).not.toHaveBeenCalled();
  });

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

  it('exposes getBrowser attachGuest', async () => {
    const attachGuest = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('window', {
      gren: {
        invoke: async () => ({ ok: true }),
        subscribe: async () => () => {},
        pickDirectory: async () => null,
        openUrl: async () => {},
        openPath: async () => {},
        revealItemInDir: async () => {},
        window: {},
        webview: {},
        browser: { attachGuest, detachGuest: async () => ({ ok: true }) },
      },
    });
    const { getBrowser } = await import('./runtime');
    await expect(getBrowser().attachGuest({ tabId: 't', webContentsId: 1 })).resolves.toEqual({ ok: true });
  });
});
