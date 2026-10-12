import { useEffect, useState, type RefObject } from 'react';

export interface ElementSize {
  width: number;
  height: number;
}

/** 元素的布局尺寸（取整）；没量到之前是 0。 */
export function useElementSize(ref: RefObject<HTMLElement | null>): ElementSize {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const apply = (width: number, height: number) => {
      const next = { width: Math.floor(width), height: Math.floor(height) };
      setSize((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
    };
    const rect = el.getBoundingClientRect();
    apply(rect.width, rect.height);
    // 回调里直接用 entry 的尺寸：同一轮里别的观察者可能刚改过 DOM，再读 getBoundingClientRect 会把整页强制重排一遍。
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const box = entry.borderBoxSize?.[0];
      if (box) apply(box.inlineSize, box.blockSize);
      else apply(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
