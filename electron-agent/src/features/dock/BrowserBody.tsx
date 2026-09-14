import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Globe, MoreHorizontal, RefreshCw } from 'lucide-react';
import { useDockStore, type BrowserPayload } from '../../stores/dockStore';
import type { DockBodyProps } from './TabBodyRenderer';

interface BrowserElement extends HTMLElement {
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  loadURL(url: string): Promise<void>;
  getURL(): string;
}

interface WebviewIpcEvent extends Event {
  channel?: string;
  args?: unknown[];
}

interface NavigationError extends Error {
  code?: string;
  errno?: number;
}

function isAbortedNavigation(error: unknown): boolean {
  const details = error as NavigationError;
  return details?.code === 'ERR_ABORTED' || details?.errno === -3;
}

function loadUrl(view: BrowserElement, url: string): void {
  void view.loadURL(url).catch((error: unknown) => {
    if (!isAbortedNavigation(error)) console.error('Browser navigation failed', error);
  });
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'about:blank';
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function BrowserBody({ tab }: DockBodyProps) {
  const payload = tab.payload as BrowserPayload;
  const webviewRef = useRef<BrowserElement | null>(null);
  const initialUrlRef = useRef(payload.url);
  const updateTab = useDockStore((state) => state.updateTab);
  const [address, setAddress] = useState(payload.url);
  const [title, setTitle] = useState(payload.title || '浏览器');
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const payloadRef = useRef(payload);
  const titleRef = useRef(title);
  payloadRef.current = payload;
  titleRef.current = title;

  useEffect(() => {
    setAddress(payload.url);
  }, [payload.url]);

  useEffect(() => {
    const view = webviewRef.current;
    if (!view) return;
    const sync = () => {
      const url = view.getURL?.() || payload.url;
      setAddress(url);
      setCanGoBack(view.canGoBack?.() ?? false);
      setCanGoForward(view.canGoForward?.() ?? false);
      const current = payloadRef.current;
      if (current.url !== url) {
        const nextPayload = { ...current, url };
        payloadRef.current = nextPayload;
        updateTab(tab.id, { payload: nextPayload, title: titleRef.current || url });
      }
    };
    const onTitle = (event: Event) => {
      const next = (event as Event & { title?: string }).title?.trim();
      if (next) {
        setTitle(next);
        const current = payloadRef.current;
        const url = view.getURL?.() || current.url;
        if (current.title !== next || current.url !== url) {
          const nextPayload = { ...current, url, title: next };
          payloadRef.current = nextPayload;
          updateTab(tab.id, { title: next, payload: nextPayload });
        }
        titleRef.current = next;
      }
    };
    const onStart = () => {
      setLoading(true);
      setLoadError(null);
    };
    const onStop = () => setLoading(false);
    const onFail = (event: Event) => {
      const details = event as Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean };
      if (details.isMainFrame === false) return;
      if (details.errorCode === -3) return;
      setLoading(false);
      setLoadError(details.errorDescription || '页面加载失败');
    };
    const onNewWindow = (event: Event) => {
      const url = (event as Event & { url?: string }).url;
      event.preventDefault();
      if (typeof url === 'string') loadUrl(view, url);
    };
    const onIpcMessage = (event: Event) => {
      const details = event as WebviewIpcEvent;
      if (details.channel !== 'gren:webview-open') return;
      const url = details.args?.[0];
      if (typeof url === 'string') loadUrl(view, url);
    };
    view.addEventListener('did-start-loading', onStart);
    view.addEventListener('did-navigate', sync);
    view.addEventListener('did-navigate-in-page', sync);
    view.addEventListener('did-stop-loading', sync);
    view.addEventListener('page-title-updated', onTitle);
    view.addEventListener('did-stop-loading', onStop);
    view.addEventListener('did-fail-load', onFail);
    view.addEventListener('new-window', onNewWindow);
    view.addEventListener('ipc-message', onIpcMessage);
    return () => {
      view.removeEventListener('did-start-loading', onStart);
      view.removeEventListener('did-navigate', sync);
      view.removeEventListener('did-navigate-in-page', sync);
      view.removeEventListener('did-stop-loading', sync);
      view.removeEventListener('page-title-updated', onTitle);
      view.removeEventListener('did-stop-loading', onStop);
      view.removeEventListener('did-fail-load', onFail);
      view.removeEventListener('new-window', onNewWindow);
      view.removeEventListener('ipc-message', onIpcMessage);
    };
  }, [tab.id, updateTab]);

  const navigate = () => {
    const next = normalizeUrl(address);
    setAddress(next);
    if (webviewRef.current) loadUrl(webviewRef.current, next);
  };

  return (
    <section className="gren-browser" aria-label="浏览器">
      <div className="gren-browser-toolbar">
        <button type="button" aria-label="后退" title="后退" disabled={!canGoBack} onClick={() => webviewRef.current?.goBack()}>
          <ArrowLeft size={15} />
        </button>
        <button type="button" aria-label="前进" title="前进" disabled={!canGoForward} onClick={() => webviewRef.current?.goForward()}>
          <ArrowRight size={15} />
        </button>
        <button type="button" aria-label="刷新" title="刷新" onClick={() => webviewRef.current?.reload()}>
          <RefreshCw size={14} />
        </button>
        <form
          className="gren-browser-address"
          onSubmit={(event) => {
            event.preventDefault();
            navigate();
          }}
        >
          <Globe size={14} aria-hidden="true" />
          <input aria-label="地址" value={address} onChange={(event) => setAddress(event.target.value)} />
        </form>
        <button type="button" aria-label="浏览器菜单" title="浏览器菜单" onClick={() => {}}>
          <MoreHorizontal size={16} />
        </button>
      </div>
      <div className="gren-browser-content">
        <webview
          ref={webviewRef as React.Ref<HTMLElement>}
          src={initialUrlRef.current}
          partition="persist:gren-browser"
          allowpopups="true"
          webpreferences="nativeWindowOpen=no"
          title={title}
        />
        {loading ? <div className="gren-browser-status">正在加载…</div> : null}
        {loadError ? <div className="gren-browser-status gren-browser-error">{loadError}</div> : null}
      </div>
    </section>
  );
}
