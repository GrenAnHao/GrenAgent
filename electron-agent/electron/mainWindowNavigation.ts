import type { BrowserWindow, WebContents } from 'electron';

/** 主进程推给渲染进程的「前进 / 后退」事件（鼠标侧键、键盘的浏览器前进 / 后退键）。 */
export const APP_NAV_EVENT = 'app-nav';
export type NavDirection = 'back' | 'forward';

/** Electron `app-command` 的命令名 → 方向；别的命令（音量、搜索……）返回 null。 */
export function appCommandDirection(command: string): NavDirection | null {
  if (command === 'browser-backward') return 'back';
  if (command === 'browser-forward') return 'forward';
  return null;
}

/**
 * Windows / Linux 上鼠标侧键和键盘的浏览器前进 / 后退键都以 `app-command` 送达主窗口。
 * 应用是单页、没有浏览器历史，不接就什么都不会发生；这里转给渲染进程，由当前悬停 / 聚焦的文件标签认领。
 */
export function forwardAppCommands(win: Pick<BrowserWindow, 'on'>, send: (direction: NavDirection) => void): void {
  win.on('app-command', (_event, command) => {
    const direction = appCommandDirection(command);
    if (direction) send(direction);
  });
}

/** 渲染进程已有的事件通道（useBrowserOpenUrl 订阅）：收到后在右侧栏新开内置浏览器标签。 */
export const BROWSER_OPEN_URL_EVENT = 'browser-open-url';

/** 同一个应用页面：协议、主机、路径都相同。hash / query 变化是应用内路由，不算离开。 */
export function isSameAppPage(url: string, appUrl: string): boolean {
  try {
    const target = new URL(url);
    const app = new URL(appUrl);
    return target.protocol === app.protocol && target.host === app.host && target.pathname === app.pathname;
  } catch {
    return false;
  }
}

export function isWebUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export interface MainWindowNavigationOptions {
  /** 应用自己的页面地址：开发时是 vite 地址，打包后是 index.html 的 file: 地址。 */
  appUrl: string;
  /** 把网页链接交给渲染进程在内置浏览器里开。 */
  openInApp: (url: string) => void;
}

/**
 * 主窗口永远不该被导航到别处，也不该自己再弹出 Electron 窗口。
 * 渲染进程的 AppLinkGuard 是第一道防线；这里是第二道：它没拦住的（`target=_blank`、被 stopPropagation 吃掉点击的链接、
 * `window.open`）一律拒绝，网页链接转成内置浏览器标签，其它协议直接丢弃。
 */
export function guardMainWindowNavigation(contents: Pick<WebContents, 'on' | 'setWindowOpenHandler'>, options: MainWindowNavigationOptions): void {
  const route = (url: string) => {
    if (isWebUrl(url)) options.openInApp(url);
  };
  contents.on('will-navigate', (event, url) => {
    if (isSameAppPage(url, options.appUrl)) return;
    event.preventDefault();
    route(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    route(url);
    return { action: 'deny' };
  });
}
