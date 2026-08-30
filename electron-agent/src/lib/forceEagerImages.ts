// Edge WebView2 对 loading="lazy" 的图片有激进的 lazy intervention（控制台会出现
// "Images loaded lazily and replaced with placeholders. Load events are deferred"），
// 会把图片替换成占位符并推迟加载。@lobehub/ui 的 Image 组件给底层 antd Image 写死了
// loading="lazy"，而它又用来渲染 mermaid 图（SVG 转 blob: URL）——于是在 Tauri WebView2 里
// mermaid 图一直停在 antd Image 的 fallback 占位、加载不出来。
//
// 这里在前端全局把 loading="lazy" 改回 eager（元素出现或 loading 属性被设上时立即改），
// 从源头避开该 intervention。普通浏览器/Electron 没有这个问题，统一处理无副作用（图片量不大）。
//
// 用 attribute API（而非 img.loading property）：和选择器、React 渲染出的属性写法一致，
// 也避免在不同 runtime 下 property 反射行为不一致。

const SELECTOR = 'img[loading="lazy"], iframe[loading="lazy"]';

function toEager(el: Element): void {
  if (el.getAttribute('loading') === 'lazy') el.setAttribute('loading', 'eager');
}

function scan(root: ParentNode): void {
  if (root instanceof Element && root.matches(SELECTOR)) toEager(root);
  root.querySelectorAll(SELECTOR).forEach(toEager);
}

export function forceEagerImages(): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => {};
  }

  scan(document);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        if (mutation.target instanceof Element) toEager(mutation.target);
        continue;
      }
      mutation.addedNodes.forEach((node) => {
        if (node instanceof Element) scan(node);
      });
    }
  });

  observer.observe(document.documentElement, {
    attributeFilter: ['loading'],
    attributes: true,
    childList: true,
    subtree: true,
  });

  return () => observer.disconnect();
}
