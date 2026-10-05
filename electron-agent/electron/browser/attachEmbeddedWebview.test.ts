import { afterEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  BrowserWindow: { fromWebContents: vi.fn(() => ({ isDestroyed: () => false })) },
  clipboard: { writeText: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
  shell: { openExternal: vi.fn() },
  webContents: { fromId: vi.fn() },
}));
vi.mock('electron', () => electron);

import { attachEmbeddedWebview, registryFor } from './attachEmbeddedWebview';
import { IPC_CHANNELS } from '../ipc/contracts';

function makeEmbedder() {
  const listeners: Record<string, Array<(...args: never[]) => void>> = {};
  return {
    listeners,
    on: vi.fn((event: string, handler: (...args: never[]) => void) => {
      (listeners[event] ??= []).push(handler);
    }),
    send: vi.fn(),
  };
}

function makeGuest() {
  const listeners: Record<string, Array<(...args: never[]) => void>> = {};
  return {
    id: 9,
    listeners,
    on: vi.fn((event: string, handler: (...args: never[]) => void) => {
      (listeners[event] ??= []).push(handler);
    }),
    setWindowOpenHandler: vi.fn(),
  };
}

describe('attachEmbeddedWebview', () => {
  it('prevents attaching a file URL and allows https', () => {
    const embedder = makeEmbedder();
    attachEmbeddedWebview(embedder as never);
    const willAttach = embedder.listeners['will-attach-webview']?.[0];
    const preventDefault = vi.fn();
    const prefs: Record<string, unknown> = {};
    willAttach?.({ preventDefault } as never, prefs as never, { src: 'file:///C:/x' } as never);
    expect(preventDefault).toHaveBeenCalled();
    preventDefault.mockClear();
    willAttach?.({ preventDefault } as never, prefs as never, { src: 'https://example.com' } as never);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(prefs).toMatchObject({ nodeIntegration: false, sandbox: true });
  });

  it('stores a registry on the embedder', () => {
    const embedder = makeEmbedder();
    attachEmbeddedWebview(embedder as never);
    expect(registryFor(embedder as never)).toBeTruthy();
  });

  it('wires popup handler and blocks javascript navigation on did-attach', () => {
    const embedder = makeEmbedder();
    attachEmbeddedWebview(embedder as never);
    const guest = makeGuest();
    embedder.listeners['did-attach-webview']?.[0]?.({} as never, guest as never);
    expect(guest.setWindowOpenHandler).toHaveBeenCalled();
    const willNavigate = guest.listeners['will-navigate']?.[0];
    const preventDefault = vi.fn();
    willNavigate?.({ preventDefault } as never, 'javascript:alert(1)' as never);
    expect(preventDefault).toHaveBeenCalled();
    preventDefault.mockClear();
    willNavigate?.({ preventDefault } as never, 'https://example.com' as never);
    expect(preventDefault).not.toHaveBeenCalled();

    const handler = guest.setWindowOpenHandler.mock.calls[0]?.[0] as
      | ((details: { url: string; disposition: string }) => { action: 'deny' })
      | undefined;
    handler?.({ url: 'https://example.com', disposition: 'new-window' });
    expect(embedder.send.mock.calls[0]?.[0]).toBe(`${IPC_CHANNELS.eventPrefix}browser-open-url`);
  });

  it('forwards dropped popup URLs to console.warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const embedder = makeEmbedder();
    attachEmbeddedWebview(embedder as never);
    const guest = makeGuest();
    embedder.listeners['did-attach-webview']?.[0]?.({} as never, guest as never);
    const handler = guest.setWindowOpenHandler.mock.calls[0]?.[0] as
      | ((details: { url: string; disposition: string }) => { action: 'deny' })
      | undefined;
    handler?.({ url: 'javascript:alert(1)', disposition: 'new-window' });
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat()).toContain('javascript:alert(1)');
    expect(embedder.send).not.toHaveBeenCalled();
    expect(electron.shell.openExternal).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
