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

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'about:blank';
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function BrowserBody({ tab }: DockBodyProps) {
  const payload = tab.payload as BrowserPayload;
  const webviewRef = useRef<BrowserElement | null>(null);
  const updateTab = useDockStore((state) => state.updateTab);
  const [address, setAddress] = useState(payload.url);
  const [title, setTitle] = useState(payload.title || '浏览器');
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

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
      updateTab(tab.id, { payload: { ...payload, url }, title: title || url });
    };
    const onTitle = (event: Event) => {
      const next = (event as Event & { title?: string }).title?.trim();
      if (next) {
        setTitle(next);
        updateTab(tab.id, { title: next, payload: { ...payload, title: next } });
      }
    };
    const onStart = () => {
      setLoading(true);
      setLoadError(null);
    };
    const onStop = () => setLoading(false);
    const onFail = (event: Event) => {
      const details = event as Event & { errorDescription?: string; isMainFrame?: boolean };
      if (details.isMainFrame === false) return;
      setLoading(false);
      setLoadError(details.errorDescription || '页面加载失败');
    };
    const onNewWindow = (event: Event) => event.preventDefault();
    view.addEventListener('did-start-loading', onStart);
    view.addEventListener('did-navigate', sync);
    view.addEventListener('did-navigate-in-page', sync);
    view.addEventListener('did-stop-loading', sync);
    view.addEventListener('page-title-updated', onTitle);
    view.addEventListener('did-stop-loading', onStop);
    view.addEventListener('did-fail-load', onFail);
    view.addEventListener('new-window', onNewWindow);
    return () => {
      view.removeEventListener('did-start-loading', onStart);
      view.removeEventListener('did-navigate', sync);
      view.removeEventListener('did-navigate-in-page', sync);
      view.removeEventListener('did-stop-loading', sync);
      view.removeEventListener('page-title-updated', onTitle);
      view.removeEventListener('did-stop-loading', onStop);
      view.removeEventListener('did-fail-load', onFail);
      view.removeEventListener('new-window', onNewWindow);
    };
  }, [payload, tab.id, title, updateTab]);

  const navigate = () => {
    const next = normalizeUrl(address);
    setAddress(next);
    void webviewRef.current?.loadURL(next);
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
          src={payload.url}
          partition="persist:gren-browser"
          title={title}
        />
        {loading ? <div className="gren-browser-status">正在加载…</div> : null}
        {loadError ? <div className="gren-browser-status gren-browser-error">{loadError}</div> : null}
      </div>
    </section>
  );
}
