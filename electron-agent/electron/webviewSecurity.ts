import { join } from 'node:path';
import { BrowserWindow, clipboard, Menu, shell, type ContextMenuParams, type WebContents } from 'electron';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'about:']);

export function isAllowedWebviewUrl(value: string): boolean {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** Apply the minimum isolation policy to every guest created by the renderer. */
export function attachWebviewSecurity(embedder: WebContents): void {
  embedder.on('will-attach-webview', (event, webPreferences, params) => {
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.preload = join(__dirname, '../preload/webviewPreload.js');
    if (!isAllowedWebviewUrl(params.src)) event.preventDefault();
  });

  embedder.on('did-attach-webview', (_event, guest) => {
    const hostWindow = BrowserWindow.fromWebContents(embedder);
    guest.on('will-navigate', (event, url) => {
      if (!isAllowedWebviewUrl(url)) event.preventDefault();
    });
    // Link/window.open routing is handled by webviewPreload via sendToHost.
    guest.setWindowOpenHandler(() => ({ action: 'deny' }));
    guest.on('context-menu', (_event, params) => {
      if (!hostWindow || hostWindow.isDestroyed()) return;
      showWebviewContextMenu(guest, params, hostWindow);
    });
  });
}

function showWebviewContextMenu(guest: WebContents, params: ContextMenuParams, hostWindow: BrowserWindow): void {
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: '后退', enabled: guest.navigationHistory.canGoBack(), click: () => guest.goBack() },
    { label: '前进', enabled: guest.navigationHistory.canGoForward(), click: () => guest.goForward() },
    { label: '刷新', click: () => guest.reload() },
  ];

  if (params.isEditable) {
    items.push(
      { type: 'separator' },
      { label: '剪切', enabled: params.editFlags.canCut, click: () => guest.cut() },
      { label: '复制', enabled: params.editFlags.canCopy, click: () => guest.copy() },
      { label: '粘贴', enabled: params.editFlags.canPaste, click: () => guest.paste() },
    );
  }

  if (params.linkURL && isAllowedWebviewUrl(params.linkURL)) {
    items.push(
      { type: 'separator' },
      { label: '在当前页面打开链接', click: () => void guest.loadURL(params.linkURL) },
      { label: '在外部浏览器打开链接', click: () => void shell.openExternal(params.linkURL) },
      { label: '复制链接地址', click: () => clipboard.writeText(params.linkURL) },
    );
  }

  items.push(
    { type: 'separator' },
    { label: '检查元素', click: () => guest.inspectElement(params.x, params.y) },
  );
  Menu.buildFromTemplate(items).popup({ window: hostWindow });
}
