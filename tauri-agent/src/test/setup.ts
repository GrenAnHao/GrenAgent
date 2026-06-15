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
}
