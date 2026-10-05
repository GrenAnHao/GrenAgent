import { useEffect } from 'react';
import { listen, type UnlistenFn } from '../../../platform/runtime';
import { openBrowserPopupTab } from './openBrowserPopupTab';

type BrowserOpenUrlPayload = { url: string; disposition: string; sourceTabId?: string };

export function useBrowserOpenUrl(): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<BrowserOpenUrlPayload>('browser-open-url', (event) => {
      openBrowserPopupTab(event.payload);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
