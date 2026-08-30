import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

interface UseAutoScrollOptions {
  /** 内容变化时触发自动滚底的依赖。 */
  deps?: unknown[];
  /** 是否启用（如仅在流式中）。默认 true。 */
  enabled?: boolean;
  /** 距底部多少 px 内视为「贴底」。默认 20。 */
  threshold?: number;
}

interface UseAutoScrollReturn<T extends HTMLElement> {
  /** 绑定到容器 onScroll，用于识别用户主动上滚。 */
  handleScroll: () => void;
  /** 绑定到可滚动容器的 ref。 */
  ref: RefObject<T | null>;
  /** 重置用户滚动锁（如新一轮内容开始时）。 */
  resetScrollLock: () => void;
  /** 用户是否已上滚离开底部（自动滚动暂停中）。 */
  userHasScrolled: boolean;
}

/**
 * 流式内容自动滚底 + 用户上滚检测（移植自 lobehub src/hooks/useAutoScroll）：
 * - deps 变化时滚到底部；
 * - 用户上滚超过 threshold 即暂停自动滚动；
 * - 自动滚动自身触发的 scroll 事件会被忽略，不会误判为用户操作；
 * - enabled 由 true 变 false（流式结束）时保持当前滚动位置不跳动。
 */
export function useAutoScroll<T extends HTMLElement = HTMLDivElement>(
  options: UseAutoScrollOptions = {},
): UseAutoScrollReturn<T> {
  const { deps = [], enabled = true, threshold = 20 } = options;

  const ref = useRef<T | null>(null);
  const [userHasScrolled, setUserHasScrolled] = useState(false);
  const isAutoScrollingRef = useRef(false);
  const prevEnabledRef = useRef(enabled);

  const handleScroll = useCallback(() => {
    if (isAutoScrollingRef.current) return;
    const container = ref.current;
    if (!container) return;

    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceToBottom >= threshold) {
      setUserHasScrolled(true);
    }
  }, [threshold]);

  const resetScrollLock = useCallback(() => {
    setUserHasScrolled(false);
  }, []);

  // 流式结束（enabled true→false）时恢复滚动位置，避免 DOM 重排后跳走。
  useEffect(() => {
    const container = ref.current;
    if (!container) return;

    if (prevEnabledRef.current && !enabled) {
      const currentScrollTop = container.scrollTop;
      isAutoScrollingRef.current = true;
      requestAnimationFrame(() => {
        container.scrollTop = currentScrollTop;
        requestAnimationFrame(() => {
          isAutoScrollingRef.current = false;
        });
      });
    }

    prevEnabledRef.current = enabled;
  }, [enabled]);

  // deps 变化时滚底（用户未上滚且启用时）。
  useEffect(() => {
    if (!enabled || userHasScrolled) return;

    const container = ref.current;
    if (!container) return;

    isAutoScrollingRef.current = true;
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
      requestAnimationFrame(() => {
        isAutoScrollingRef.current = false;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, userHasScrolled, ...deps]);

  return { handleScroll, ref, resetScrollLock, userHasScrolled };
}
