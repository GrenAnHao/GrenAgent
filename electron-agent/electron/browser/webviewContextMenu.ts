import { BrowserWindow, clipboard, Menu, shell, type ContextMenuParams, type WebContents } from 'electron';
import { isAllowedWebviewUrl } from './webviewPolicy';

export function showWebviewContextMenu(guest: WebContents, params: ContextMenuParams, hostWindow: BrowserWindow): void {
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
