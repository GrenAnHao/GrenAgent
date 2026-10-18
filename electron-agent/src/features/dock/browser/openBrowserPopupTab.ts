import { useDockStore } from '../../../stores/dockStore';
import { nextBrowserTabId } from '../openLauncherTab';
import { isAllowedPopupUrl } from './browserUrls';

export function openBrowserPopupTab(payload: { url: string; disposition: string; sourceTabId?: string }): void {
  if (!isAllowedPopupUrl(payload.url)) return;
  const source = useDockStore.getState().tabs.find((t) => t.id === payload.sourceTabId);
  const region = source?.region ?? 'right';
  useDockStore.getState().addTab({
    id: nextBrowserTabId(),
    kind: 'browser',
    region,
    title: '浏览器',
    closable: true,
    payload: { url: payload.url, title: '浏览器' },
    // 弹窗归到打开它的页面所在的会话（页面可能在后台会话里常驻），没有来源时由 addTab 记到当前会话。
    ...(source && source.ownerSessionPath !== undefined
      ? { ownerSessionPath: source.ownerSessionPath, ownerWorkspace: source.ownerWorkspace }
      : {}),
  });
}
