import { useCallback, useLayoutEffect, useRef } from 'react';

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((item, index) => Object.is(item, b[index]));
}

function shallowEqual(a: object, b: object): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((key) => sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/**
 * 结构共享：新一轮里字段都没变的条目沿用上一轮的对象（数组字段按元素引用比较），
 * 整组都没变就沿用上一轮的数组。侧栏的列表每次切会话都会整份重建，
 * 不共享的话 memo 的行组件拿到的全是新对象，全部重渲。
 */
export function shareUnchanged<T extends object>(prev: readonly T[] | undefined, next: T[], key: (item: T) => string): T[] {
  if (!prev || prev.length === 0) return next;
  const byKey = new Map(prev.map((item) => [key(item), item]));
  let reusedAll = prev.length === next.length;
  const shared = next.map((item, index) => {
    const old = byKey.get(key(item));
    const keep = old !== undefined && shallowEqual(old, item);
    if (!keep || prev[index] !== old) reusedAll = false;
    return keep ? old : item;
  });
  return reusedAll ? (prev as T[]) : shared;
}

/** 引用恒定、调用时转到最新一次渲染的函数。只用于事件回调，渲染期间不要调用。 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}
