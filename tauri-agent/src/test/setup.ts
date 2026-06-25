import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
afterEach(cleanup);
// jsdom 缺少的浏览器 API 垫片（antd / @lobehub/ui 组件测试需要）。
if (typeof window !== 'undefined') {
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }
  if (!window.ResizeObserver) {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    window.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  }
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = () => {};
  }
  // @base-ui 的 ScrollArea viewport 会调用 Web Animations API；jsdom 未实现，补空垫片。
  if (!Element.prototype.getAnimations) {
    Element.prototype.getAnimations = () => [];
  }
  // jsdom 在本环境下的 localStorage 缺少可用的 setItem（zustand persist 写入会抛
  // "storage.setItem is not a function"）。用 Map 后端的 Storage 垫片兜底。
  const hasStorage =
    typeof window.localStorage !== 'undefined' &&
    typeof window.localStorage.setItem === 'function';
  if (!hasStorage) {
    const makeStorage = (): Storage => {
      const m = new Map<string, string>();
      return {
        get length() {
          return m.size;
        },
        clear: () => m.clear(),
        getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
        key: (i: number) => Array.from(m.keys())[i] ?? null,
        removeItem: (k: string) => void m.delete(k),
        setItem: (k: string, v: string) => void m.set(k, String(v)),
      };
    };
    Object.defineProperty(window, 'localStorage', { configurable: true, value: makeStorage() });
    Object.defineProperty(window, 'sessionStorage', { configurable: true, value: makeStorage() });
  }
}
