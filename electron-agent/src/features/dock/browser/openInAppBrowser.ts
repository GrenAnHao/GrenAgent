import { currentDockView, isDockTabVisible, useDockStore, type BrowserPayload } from '../../../stores/dockStore';
import { useLayoutStore } from '../../../stores/layoutStore';
import { nextBrowserTabId } from '../openLauncherTab';
import { isAllowedPopupUrl } from './browserUrls';

function hostTitle(url: string): string {
  try {
    return new URL(url).hostname || '浏览器';
  } catch {
    return '浏览器';
  }
}

function sameAddress(left: string, right: string): boolean {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return left === right;
  }
}

/**
 * 在右侧栏的内置浏览器标签里打开一个网页链接。对话和文件预览里的链接统一走这里。
 *
 * - 只认 http / https，其余返回 false，由调用方提示。
 * - 当前会话已经有同一个地址的浏览器标签就切过去，不重复开；否则新开一个标签（点十条链接得到十个标签，
 *   比覆盖正在看的页面安全；同地址不重开，避免来回点同一条链接堆标签）。
 * - 标签归属当前会话，登录状态在 `persist:gren-browser` 分区里跨标签保留。
 */
export function openInAppBrowser(url: string): boolean {
  if (!isAllowedPopupUrl(url)) return false;
  const dock = useDockStore.getState();
  const view = currentDockView();
  const existing = dock.tabs.find(
    (tab) =>
      tab.kind === 'browser' &&
      tab.region === 'right' &&
      isDockTabVisible(tab, view) &&
      sameAddress((tab.payload as BrowserPayload).url, url),
  );
  if (existing) {
    dock.setActive('right', existing.id);
    useLayoutStore.getState().setRightPanelOpen(true);
    return true;
  }
  const title = hostTitle(url);
  dock.addTab({
    id: nextBrowserTabId(),
    kind: 'browser',
    region: 'right',
    title,
    closable: true,
    payload: { url, title },
  });
  return true;
}
