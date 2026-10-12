import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * 从元素的布局尺寸（取整）派生一个值，派生结果变了才重渲染。
 *
 * 拖分隔条、缩窗口时尺寸每帧都在变，只关心「够不够宽」「要收起几个」的组件不该跟着每帧重渲整棵子树。
 * derive 要用 useCallback 稳住；它的依赖变了会用最近一次量到的尺寸重算（还没量到时按 0×0 算）。
 * 返回值按 Object.is 比较，派生出数组 / 对象会每次都重渲，派生成字符串或数字。
 */
export function useElementMeasure<T>(
  ref: RefObject<HTMLElement | null>,
  derive: (width: number, height: number) => T,
): T {
  const [value, setValue] = useState(() => derive(0, 0));
  const deriveRef = useRef(derive);
  const sizeRef = useRef({ width: 0, height: 0 });

  useLayoutEffect(() => {
    deriveRef.current = derive;
    setValue(derive(sizeRef.current.width, sizeRef.current.height));
  }, [derive]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const apply = (width: number, height: number) => {
      sizeRef.current = { width: Math.floor(width), height: Math.floor(height) };
      setValue(deriveRef.current(sizeRef.current.width, sizeRef.current.height));
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

  return value;
}
