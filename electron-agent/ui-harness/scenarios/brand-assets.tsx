import { lazy, Suspense, useState } from 'react';
import { GrenAgentIcon, GrenAgentLogo } from '../../src/components/GrenAgentLogo';
import { EmptyChatPrompt } from '../../src/features/chat/EmptyChatPrompt';
import { BrowserBody } from '../../src/features/dock/browser/BrowserBody';
import { BrowserErrorState } from '../../src/features/dock/browser/BrowserErrorState';
import { browserErrorPageUrl } from '../../src/features/dock/browser/browserNavigation';
import { useBrowserHistoryStore } from '../../src/features/dock/browser/browserHistoryStore';
import { useDockStore, type DockTab } from '../../src/stores/dockStore';
import { useSidebarPrefsStore } from '../../src/stores/sidebarPrefsStore';
import iconSource from '../../brand/source/grenagent-icon.svg?raw';
import logoSource from '../../brand/source/grenagent-logo.svg?raw';
import { exposeActions, exposeData, installBridge, track } from '../stubs';

// Only native window/guest I/O is stubbed. BrowserBody renders its actual new-tab branch;
// this scenario never navigates a guest or calls a model.
installBridge({
  invoke: async (command: string) => { throw new Error(`unstubbed invoke: ${command}`); },
  subscribe: async () => () => {},
  window: {
    isMaximized: async () => false,
    onResized: async () => () => {},
    minimize: async () => track('window:minimize'),
    toggleMaximize: async () => track('window:maximize'),
    close: async () => track('window:close'),
  },
  browser: {
    attachGuest: async () => ({ ok: true }),
    detachGuest: async () => ({ ok: true }),
  },
});

// Titlebar captures the window bridge at module initialization.
const Titlebar = lazy(async () => ({ default: (await import('../../src/components/Titlebar')).Titlebar }));
const workspace = 'D:/brand-fixture';
const sizes = [16, 18, 24, 32, 48];
const browserTab: DockTab = {
  id: 'brand-new-tab', kind: 'browser', region: 'right', title: '新标签页',
  closable: true, order: 0, payload: { url: 'about:blank', title: '新标签页' },
};
const guestErrorUrl = browserErrorPageUrl({ errorCode: -100, url: 'https://brand.invalid/' });
// Render the actual generated document. Only scripts are removed; its markup and styles
// remain untouched. The sandbox also prevents scripts from navigating to the fixture URL.
const guestErrorDocument = decodeURIComponent(guestErrorUrl.slice(guestErrorUrl.indexOf(',') + 1))
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
let setGuestPreview = (_show: boolean): void => {};
exposeActions({ showGuestError: () => setGuestPreview(true), showOverview: () => setGuestPreview(false) });

useSidebarPrefsStore.setState({ aliases: { [workspace]: 'GrenAgent 项目' } });
useBrowserHistoryStore.setState({ entries: [] });
useDockStore.setState({ tabs: [browserTab] });

function sourceGeometry(source: string) {
  const svg = new DOMParser().parseFromString(source, 'image/svg+xml').documentElement;
  return {
    viewBox: svg.getAttribute('viewBox'),
    paths: [...svg.querySelectorAll('path')].map((path) => {
      const transforms: string[] = [];
      let node: Element | null = path;
      while (node && node !== svg) {
        const transform = node.getAttribute('transform');
        if (transform) transforms.unshift(transform);
        node = node.parentElement;
      }
      return { d: path.getAttribute('d'), transforms };
    }),
  };
}

exposeData({ icon: sourceGeometry(iconSource), logo: sourceGeometry(logoSource), sizes });

export default function BrandAssetsScenario() {
  const [guestPreview, showGuestPreview] = useState(false);
  setGuestPreview = showGuestPreview;
  return (
    <main
      data-testid="brand-stage"
      style={{ height: '100vh', overflow: 'auto', background: 'var(--gren-content-bg)', color: 'var(--gren-fg)' }}
    >
      <Suspense fallback={null}><Titlebar /></Suspense>
      {guestPreview ? (
        <iframe
          data-testid="brand-guest-error"
          title="浏览器真实加载失败页面"
          sandbox="allow-same-origin"
          srcDoc={guestErrorDocument}
          style={{ display: 'block', width: '100%', height: 'calc(100vh - 38px)', border: 0 }}
        />
      ) : <div style={{ maxWidth: 1200, margin: '0 auto', padding: 24 }}>
        <section aria-label="品牌原稿预览" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 32, paddingBlock: 20 }}>
          <GrenAgentLogo width={320} data-testid="brand-logo-sample" style={{ maxWidth: '100%', height: 'auto' }} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'end' }}>
            {sizes.map((size) => (
              <div key={size} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                <GrenAgentIcon size={size} data-testid={`brand-icon-${size}`} />
                <span style={{ fontSize: 11, color: 'var(--gren-fg-muted)' }}>{size}px</span>
              </div>
            ))}
          </div>
        </section>
        <section aria-label="新对话品牌" style={{ paddingBlock: 22, borderBlock: '1px solid var(--gren-border)' }}>
          <EmptyChatPrompt workspace={workspace} isConversation={false} />
        </section>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))', gap: 24, paddingTop: 24 }}>
          <section data-testid="brand-browser-panel" aria-label="真实浏览器新页" style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: 13, fontWeight: 500, color: 'var(--gren-fg-muted)', margin: '0 0 12px' }}>浏览器 · 新标签页</h2>
            <div style={{ height: 430, display: 'flex', border: '1px solid var(--gren-border)', borderRadius: 10, overflow: 'hidden' }}>
              <BrowserBody tab={browserTab} active />
            </div>
          </section>
          <section data-testid="brand-error-panel" aria-label="真实浏览器错误页" style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: 13, fontWeight: 500, color: 'var(--gren-fg-muted)', margin: '0 0 12px' }}>浏览器 · 错误状态</h2>
            <div style={{ position: 'relative', height: 430, border: '1px solid var(--gren-border)', borderRadius: 10, overflow: 'hidden' }}>
              <BrowserErrorState
                title="暂时无法打开此页面"
                summary="请检查网络连接后重试。"
                suggestions={[]}
                errorCode="ERR_CONNECTION_CLOSED"
                actionLabel="重新加载"
                onAction={() => track('browser-error:retry')}
              />
            </div>
          </section>
        </div>
      </div>}
    </main>
  );
}
