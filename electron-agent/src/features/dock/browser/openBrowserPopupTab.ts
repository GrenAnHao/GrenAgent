import { useDockStore } from '../../../stores/dockStore';
import { nextBrowserTabId } from '../openLauncherTab';
import { isAllowedPopupUrl } from './browserUrls';

export function openBrowserPopupTab(payload: { url: string; disposition: string; sourceTabId?: string }): void {
  if (!isAllowedPopupUrl(payload.url)) return;
  const region = useDockStore.getState().tabs.find((t) => t.id === payload.sourceTabId)?.region ?? 'right';
  useDockStore.getState().addTab({
    id: nextBrowserTabId(),
    kind: 'browser',
    region,
    title: '浏览器',
    closable: true,
    payload: { url: payload.url, title: '浏览器' },
  });
}
