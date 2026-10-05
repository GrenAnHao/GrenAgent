import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Globe, MonitorSmartphone, MoreHorizontal, MousePointerClick, RefreshCw } from 'lucide-react';
import { PiBrandLogo } from '../../../components/PiBrandLogo';
import { getBrowser } from '../../../platform/runtime';
import { useDockStore, type BrowserPayload } from '../../../stores/dockStore';
import type { DockBodyProps } from '../TabBodyRenderer';
import { BrowserAddressSuggest } from './BrowserAddressSuggest';
import { BrowserErrorState } from './BrowserErrorState';
import {
  displayBrowserHistoryUrl,
  listOpenBrowserTabs,
  suggestBrowserHistory,
  type AddressSuggestFilter,
  type BrowserHistorySuggestion,
} from './browserHistory';
import { useBrowserHistoryStore } from './browserHistoryStore';
import {
  BROWSER_ADDRESS_PLACEHOLDER,
  documentBrowserUrl,
  isAllowedDocumentUrl,
  isBlankBrowserUrl,
  normalizeAddressInput,
  visibleBrowserUrl,
} from './browserUrls';
import {
  buildBrowserElementPickerScript,
  buildCancelBrowserElementPickerScript,
  formatBrowserElementOffer,
  offerBrowserElementToChat,
  parseBrowserElementPick,
} from './browserElementPicker';
import { browserErrorPageUrl, describeBrowserGuestFailure, isBrowserErrorPageUrl, isExpectedNavigationFailure } from './browserNavigation';
import { DEFAULT_BROWSER_VIEWPORT } from './browserViewport';
import { ResponsiveBrowserViewport } from './ResponsiveBrowserViewport';
import { safeWebviewCall } from './safeWebviewCall';

interface BrowserElement extends HTMLElement {
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getWebContentsId(): number;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

function loadUrl(view: BrowserElement, url: string): void {
  void view.loadURL(url).catch((error: unknown) => {
    if (!isExpectedNavigationFailure(error)) console.error('Browser navigation failed', error);
  });
}

const RECOVERABLE = new Set(['crashed', 'oom', 'killed', 'abnormal-exit']);

export function BrowserBody({ tab }: DockBodyProps) {
  const payload = tab.payload as BrowserPayload;
  const webviewRef = useRef<BrowserElement | null>(null);
  const addressWrapRef = useRef<HTMLDivElement | null>(null);
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const lastRestorableUrlRef = useRef(payload.url);
  const updateTab = useDockStore((state) => state.updateTab);
  const setActive = useDockStore((state) => state.setActive);
  const tabs = useDockStore((state) => state.tabs);
  const rememberVisit = useBrowserHistoryStore((state) => state.remember);
  const historyEntries = useBrowserHistoryStore((state) => state.entries);
  const [webviewGeneration, setWebviewGeneration] = useState(0);
  const [guestSrc, setGuestSrc] = useState<string | undefined>(payload.url);
  const [address, setAddress] = useState(() => visibleBrowserUrl(payload.url, payload.url));
  const [blankPage, setBlankPage] = useState(() => isBlankBrowserUrl(payload.url));
  const [title, setTitle] = useState(payload.title || '浏览器');
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loading, setLoading] = useState(() => !isBlankBrowserUrl(payload.url));
  const [guestFailure, setGuestFailure] = useState<string | null>(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestFilter, setSuggestFilter] = useState<AddressSuggestFilter>('all');
  const [activeSuggest, setActiveSuggest] = useState(0);
  const [responsive, setResponsive] = useState(false);
  const [viewportSize, setViewportSize] = useState(DEFAULT_BROWSER_VIEWPORT);
  const [picking, setPicking] = useState(false);
  const payloadRef = useRef(payload);
  const titleRef = useRef(title);
  const tabIdRef = useRef(tab.id);
  const recoveringRef = useRef(false);
  const faviconBoundRef = useRef<BrowserElement | null>(null);
  const faviconHandlerRef = useRef<((event: Event) => void) | null>(null);
  const pickingSeqRef = useRef(0);
  payloadRef.current = payload;
  titleRef.current = title;
  tabIdRef.current = tab.id;

  useEffect(() => {
    setAddress(visibleBrowserUrl(payload.url, payload.url));
    setBlankPage(isBlankBrowserUrl(payload.url));
  }, [payload.url]);

  const rebuildGuest = (url: string) => {
    lastRestorableUrlRef.current = url;
    setGuestSrc(url);
    setWebviewGeneration((n) => n + 1);
  };

  const setWebviewNode = useCallback((node: HTMLElement | null) => {
    if (faviconBoundRef.current && faviconHandlerRef.current) {
      faviconBoundRef.current.removeEventListener('page-favicon-updated', faviconHandlerRef.current);
    }
    const next = node as BrowserElement | null;
    faviconBoundRef.current = next;
    webviewRef.current = next;
    if (!next) {
      faviconHandlerRef.current = null;
      return;
    }
    const onFavicon = (event: Event) => {
      const faviconUrl = (event as Event & { favicons?: string[] }).favicons?.[0];
      if (!faviconUrl) return;
      const current = payloadRef.current;
      if (current.faviconUrl === faviconUrl) return;
      const nextPayload = { ...current, faviconUrl };
      payloadRef.current = nextPayload;
      updateTab(tabIdRef.current, { payload: nextPayload });
      rememberVisit({
        url: current.url,
        title: titleRef.current,
        faviconUrl,
      });
    };
    faviconHandlerRef.current = onFavicon;
    next.addEventListener('page-favicon-updated', onFavicon);
  }, [rememberVisit, updateTab]);

  useEffect(() => {
    const view = webviewRef.current;
    if (!view) return;
    const pinDocumentUrl = (url: string) => {
      if (!isAllowedDocumentUrl(url)) return;
      setAddress(visibleBrowserUrl(url, url));
      setBlankPage(isBlankBrowserUrl(url));
      if (!isBlankBrowserUrl(url)) {
        lastRestorableUrlRef.current = url;
        rememberVisit({
          url,
          title: titleRef.current,
          faviconUrl: payloadRef.current.faviconUrl,
        });
      }
      const current = payloadRef.current;
      if (current.url === url) return;
      const nextPayload = { ...current, url };
      payloadRef.current = nextPayload;
      updateTab(tab.id, { payload: nextPayload, title: titleRef.current || url });
    };
    const sync = () => {
      const guestUrl = safeWebviewCall(() => view.getURL(), lastRestorableUrlRef.current);
      pinDocumentUrl(documentBrowserUrl(guestUrl, lastRestorableUrlRef.current));
      setCanGoBack(safeWebviewCall(() => view.canGoBack(), false));
      setCanGoForward(safeWebviewCall(() => view.canGoForward(), false));
    };
    const onTitle = (event: Event) => {
      const next = (event as Event & { title?: string }).title?.trim();
      if (next) {
        setTitle(next);
        const current = payloadRef.current;
        const guestUrl = safeWebviewCall(() => view.getURL(), lastRestorableUrlRef.current);
        const url = documentBrowserUrl(guestUrl, lastRestorableUrlRef.current);
        if (current.title !== next || current.url !== url) {
          const nextPayload = { ...current, url, title: next };
          payloadRef.current = nextPayload;
          updateTab(tab.id, { title: next, payload: nextPayload });
        }
        titleRef.current = next;
        rememberVisit({
          url,
          title: next,
          faviconUrl: payloadRef.current.faviconUrl,
        });
      }
    };
    const onStart = () => setLoading(true);
    const onStop = () => setLoading(false);
    const onFail = (event: Event) => {
      const details = event as Event & {
        errorCode?: number;
        errorDescription?: string;
        isMainFrame?: boolean;
        validatedURL?: string;
      };
      if (!details.isMainFrame || details.errorCode === -3) return;
      const failedUrl = details.validatedURL || lastRestorableUrlRef.current;
      if (!isAllowedDocumentUrl(failedUrl)) return;
      if (isBrowserErrorPageUrl(failedUrl) || isBrowserErrorPageUrl(safeWebviewCall(() => view.getURL(), ''))) return;
      setLoading(false);
      pinDocumentUrl(failedUrl);
      loadUrl(view, browserErrorPageUrl({
        errorCode: details.errorCode ?? 0,
        errorDescription: details.errorDescription,
        url: failedUrl,
      }));
    };
    const onGone = (event: Event) => {
      const current = webviewRef.current;
      if (!current || event.target !== current) return;
      const details = event as Event & { reason?: string; details?: { reason?: string } };
      const reason = details.details?.reason ?? details.reason;
      if (!reason) return;
      if (!RECOVERABLE.has(reason)) {
        setGuestFailure(reason);
        return;
      }
      if (recoveringRef.current) return;
      recoveringRef.current = true;
      void getBrowser().detachGuest({ tabId: tab.id });
      rebuildGuest(lastRestorableUrlRef.current);
    };
    const onReady = () => {
      recoveringRef.current = false;
      setGuestFailure(null);
    };
    const onAttach = () => {
      view.removeAttribute('src');
      setGuestSrc((current) => (current === undefined ? current : undefined));
      void getBrowser().attachGuest({ tabId: tab.id, webContentsId: view.getWebContentsId() });
    };
    view.addEventListener('did-start-loading', onStart);
    view.addEventListener('did-navigate', sync);
    view.addEventListener('did-navigate-in-page', sync);
    view.addEventListener('did-stop-loading', sync);
    view.addEventListener('page-title-updated', onTitle);
    view.addEventListener('did-stop-loading', onStop);
    view.addEventListener('did-fail-load', onFail);
    view.addEventListener('render-process-gone', onGone);
    view.addEventListener('dom-ready', onReady);
    view.addEventListener('did-attach', onAttach);
    const webContentsId = safeWebviewCall<number | undefined>(() => view.getWebContentsId?.(), undefined);
    if (webContentsId !== undefined) {
      void getBrowser().attachGuest({ tabId: tab.id, webContentsId });
    }
    return () => {
      pickingSeqRef.current += 1;
      setPicking(false);
      view.removeEventListener('did-start-loading', onStart);
      view.removeEventListener('did-navigate', sync);
      view.removeEventListener('did-navigate-in-page', sync);
      view.removeEventListener('did-stop-loading', sync);
      view.removeEventListener('page-title-updated', onTitle);
      view.removeEventListener('did-stop-loading', onStop);
      view.removeEventListener('did-fail-load', onFail);
      view.removeEventListener('render-process-gone', onGone);
      view.removeEventListener('dom-ready', onReady);
      view.removeEventListener('did-attach', onAttach);
      void getBrowser().detachGuest({ tabId: tab.id });
    };
  }, [tab.id, webviewGeneration, updateTab, rememberVisit]);

  const suggestions = useMemo(
    () => suggestBrowserHistory(
      address,
      historyEntries,
      listOpenBrowserTabs(tabs),
      tab.id,
      suggestFilter,
      payload.url,
    ),
    [address, historyEntries, tabs, tab.id, suggestFilter, payload.url],
  );

  useEffect(() => {
    setActiveSuggest(0);
  }, [address, suggestFilter, suggestOpen]);

  useEffect(() => {
    if (!suggestOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!addressWrapRef.current?.contains(event.target as Node)) {
        setSuggestOpen(false);
        setSuggestFilter('all');
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [suggestOpen]);

  const closeSuggest = () => {
    setSuggestOpen(false);
    setSuggestFilter('all');
    addressInputRef.current?.blur();
  };

  const applySuggestion = (item: BrowserHistorySuggestion) => {
    closeSuggest();
    if (item.openTabId && item.openTabRegion) {
      setActive(item.openTabRegion, item.openTabId);
      return;
    }
    setAddress(item.url);
    if (!isAllowedDocumentUrl(item.url)) return;
    if (webviewRef.current) loadUrl(webviewRef.current, item.url);
  };

  const navigate = () => {
    closeSuggest();
    const next = normalizeAddressInput(address);
    setAddress(visibleBrowserUrl(next, next));
    if (!isAllowedDocumentUrl(next)) return;
    if (webviewRef.current) loadUrl(webviewRef.current, next);
  };

  const reopen = () => {
    rebuildGuest(lastRestorableUrlRef.current);
  };

  const runView = (run: (view: BrowserElement) => void) => {
    const view = webviewRef.current;
    if (!view) return;
    safeWebviewCall(() => {
      run(view);
    }, undefined);
  };

  const cancelGuestPicker = useCallback((view?: BrowserElement | null) => {
    pickingSeqRef.current += 1;
    setPicking(false);
    const target = view === undefined ? webviewRef.current : view;
    if (!target) return;
    void safeWebviewCall(
      () => target.executeJavaScript(buildCancelBrowserElementPickerScript(), true),
      undefined,
    );
  }, []);

  useEffect(() => {
    if (!picking) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      cancelGuestPicker();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancelGuestPicker, picking]);

  const togglePicker = () => {
    if (picking) {
      cancelGuestPicker();
      return;
    }
    if (blankPage || guestFailure) return;
    const view = webviewRef.current;
    if (!view) return;
    closeSuggest();
    const seq = pickingSeqRef.current + 1;
    pickingSeqRef.current = seq;
    setPicking(true);
    void (async () => {
      try {
        const raw = await view.executeJavaScript(buildBrowserElementPickerScript(), true);
        if (pickingSeqRef.current !== seq) return;
        const pick = parseBrowserElementPick(raw);
        if (pick?.status === 'selected') {
          offerBrowserElementToChat(formatBrowserElementOffer(pick, {
            tabId: tabIdRef.current,
            tabTitle: titleRef.current,
          }));
        }
      } catch {
        // guest gone or executeJavaScript rejected
      } finally {
        if (pickingSeqRef.current === seq) setPicking(false);
      }
    })();
  };

  const hideGuest = Boolean(guestFailure);
  const guestFailureView = guestFailure ? describeBrowserGuestFailure(guestFailure) : null;
  const showNewTab = blankPage && !guestFailure;
  const ntpShortcuts = historyEntries.slice(0, 8);

  return (
    <section className="gren-browser" aria-label="浏览器">
      <div className="gren-browser-toolbar">
        <button type="button" aria-label="后退" title="后退" disabled={!canGoBack} onClick={() => runView((view) => view.goBack())}>
          <ArrowLeft size={15} />
        </button>
        <button type="button" aria-label="前进" title="前进" disabled={!canGoForward} onClick={() => runView((view) => view.goForward())}>
          <ArrowRight size={15} />
        </button>
        <button
          type="button"
          aria-label="刷新"
          title="刷新"
          aria-busy={loading ? 'true' : 'false'}
          onClick={() => runView((view) => {
            const guestUrl = safeWebviewCall(() => view.getURL(), '');
            if (isAllowedDocumentUrl(guestUrl)) view.reload();
            else loadUrl(view, lastRestorableUrlRef.current);
          })}
        >
          <RefreshCw size={14} className={loading ? 'gren-browser-spin' : undefined} />
        </button>
        <div className="gren-browser-address-wrap" ref={addressWrapRef}>
          <form
            className={`gren-browser-address${address.trim() ? '' : ' gren-browser-address-blank'}`}
            onSubmit={(event) => {
              event.preventDefault();
              navigate();
            }}
          >
            {address.trim() ? <Globe size={14} aria-hidden="true" /> : null}
            <input
              ref={addressInputRef}
              aria-label="地址"
              aria-autocomplete="list"
              aria-expanded={suggestOpen}
              aria-controls="gren-browser-suggest"
              placeholder={BROWSER_ADDRESS_PLACEHOLDER}
              value={address}
              onChange={(event) => {
                setAddress(event.target.value);
                setSuggestOpen(true);
              }}
              onFocus={() => setSuggestOpen(true)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setSuggestOpen(true);
                  setActiveSuggest((index) => Math.min(index + 1, Math.max(suggestions.length - 1, 0)));
                  return;
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setActiveSuggest((index) => Math.max(index - 1, 0));
                  return;
                }
                if (event.key === 'Escape') {
                  closeSuggest();
                  return;
                }
                if (event.key === 'Enter' && suggestOpen) {
                  const selected = suggestions[activeSuggest];
                  if (selected && selected.kind !== 'typed') {
                    event.preventDefault();
                    applySuggestion(selected);
                  }
                }
              }}
            />
          </form>
          <BrowserAddressSuggest
            open={suggestOpen}
            items={suggestions}
            filter={suggestFilter}
            activeIndex={activeSuggest}
            onFilter={setSuggestFilter}
            onHover={setActiveSuggest}
            onPick={applySuggestion}
            onSwitchTab={applySuggestion}
          />
        </div>
        <button
          type="button"
          aria-label="自由尺寸"
          title="自由尺寸"
          aria-pressed={responsive}
          onClick={() => setResponsive((current) => !current)}
        >
          <MonitorSmartphone size={15} />
        </button>
        <button
          type="button"
          aria-label="选择元素"
          title="选择网页元素加入聊天"
          aria-pressed={picking}
          disabled={blankPage || Boolean(guestFailure)}
          onClick={togglePicker}
        >
          <MousePointerClick size={15} />
        </button>
        <button type="button" aria-label="浏览器菜单" title="浏览器菜单" onClick={() => {}}>
          <MoreHorizontal size={16} />
        </button>
      </div>
      <div className="gren-browser-content">
        {suggestOpen ? (
          <div
            className="gren-browser-suggest-dismiss"
            data-testid="gren-browser-suggest-dismiss"
            aria-hidden="true"
            onPointerDown={(event) => {
              event.preventDefault();
              closeSuggest();
            }}
          />
        ) : null}
        <ResponsiveBrowserViewport
          active={responsive}
          size={viewportSize}
          onSizeChange={setViewportSize}
        >
          {showNewTab ? (
            <div className="gren-browser-ntp" data-testid="gren-browser-ntp">
              <span className="gren-browser-ntp-logo" aria-hidden="true">
                <PiBrandLogo size={64} tight />
              </span>
              <button
                type="button"
                className="gren-browser-ntp-search"
                onClick={() => addressInputRef.current?.focus()}
              >
                {BROWSER_ADDRESS_PLACEHOLDER}
              </button>
              {ntpShortcuts.length > 0 ? (
                <div className="gren-browser-ntp-shortcuts">
                  {ntpShortcuts.map((item) => (
                    <button
                      key={item.url}
                      type="button"
                      className="gren-browser-ntp-shortcut"
                      onClick={() => {
                        closeSuggest();
                        setAddress(item.url);
                        if (webviewRef.current) loadUrl(webviewRef.current, item.url);
                      }}
                    >
                      {item.faviconUrl ? (
                        <img className="gren-browser-ntp-favicon" src={item.faviconUrl} alt="" />
                      ) : (
                        <Globe size={20} aria-hidden="true" />
                      )}
                      <span className="gren-browser-ntp-shortcut-title">{item.title}</span>
                      <span className="gren-browser-ntp-shortcut-url">{displayBrowserHistoryUrl(item.url)}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <webview
            key={`webview:${webviewGeneration}`}
            ref={setWebviewNode}
            {...(guestSrc ? { src: guestSrc } : {})}
            partition="persist:gren-browser"
            allowpopups="true"
            title={title}
            style={hideGuest ? { display: 'none' } : undefined}
          />
        </ResponsiveBrowserViewport>
        {guestFailureView ? (
          <BrowserErrorState
            title={guestFailureView.title}
            summary={guestFailureView.summary}
            suggestions={guestFailureView.suggestions}
            errorCode={guestFailureView.errorCode}
            actionLabel="重新打开"
            onAction={reopen}
          />
        ) : null}
      </div>
    </section>
  );
}
