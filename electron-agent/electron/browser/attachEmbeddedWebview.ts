import { join } from 'node:path';
import { BrowserWindow, shell, webContents, type WebContents } from 'electron';
import { IPC_CHANNELS } from '../ipc/contracts';
import { applyWillAttachPolicy, isAllowedWebviewUrl } from './webviewPolicy';
import { WebviewGuestRegistry } from './webviewGuestRegistry';
import { attachGuestWindowOpenHandler } from './webviewPopup';
import { showWebviewContextMenu } from './webviewContextMenu';

const registries = new WeakMap<WebContents, WebviewGuestRegistry>();

export function registryFor(embedder: WebContents): WebviewGuestRegistry | undefined {
  return registries.get(embedder);
}

export function attachGuestCommand(embedder: WebContents, tabId: string, webContentsId: number): { ok: boolean } {
  const guest = webContents.fromId(webContentsId);
  if (!guest) return { ok: false };
  return registryFor(embedder)?.attach(tabId, guest) ?? { ok: false };
}

export function detachGuestCommand(embedder: WebContents, tabId: string): { ok: boolean } {
  registryFor(embedder)?.detach(tabId);
  return { ok: true };
}

export function attachEmbeddedWebview(embedder: WebContents): void {
  const registry = new WebviewGuestRegistry();
  registries.set(embedder, registry);
  const preloadPath = join(__dirname, '../preload/webviewPreload.js');

  embedder.on('will-attach-webview', (event, webPreferences, params) => {
    const allowed = applyWillAttachPolicy(webPreferences, params as unknown as Record<string, unknown>, preloadPath);
    if (!allowed) event.preventDefault();
  });

  embedder.on('did-attach-webview', (_event, guest) => {
    guest.on('will-navigate', (event, url) => {
      if (!isAllowedWebviewUrl(url)) event.preventDefault();
    });
    attachGuestWindowOpenHandler({
      guest,
      embedder,
      tabIdFor: (id) => registry.tabIdFor(id),
      eventChannel: `${IPC_CHANNELS.eventPrefix}browser-open-url`,
      openExternal: (url) => shell.openExternal(url),
      sendInternal: (channel, payload) => embedder.send(channel, payload),
      warn: (...args: unknown[]) => {
        console.warn(...args);
      },
    });
    guest.on('context-menu', (_event, params) => {
      const hostWindow = BrowserWindow.fromWebContents(embedder);
      if (!hostWindow || hostWindow.isDestroyed()) return;
      showWebviewContextMenu(guest, params, hostWindow);
    });
  });
}
