import { useEffect, useMemo, useRef, type Ref } from 'react';
import type { DisplayMessage } from '../chat/groupMessages';
import type { TranscriptScrollHandle } from '../chat/VirtualizedMessageList';
import { DomFinder, type FinderItem } from './domFinder';
import { registerFindScope } from './findActions';
import { cachedVisibleItemText } from './findMatch';
import { useFindScope, useFindStore } from './findStore';
import { useFindDriver } from './useFindDriver';

export const CHAT_FIND_SCOPE = 'chat';

function handleOf(ref: Ref<TranscriptScrollHandle> | undefined): TranscriptScrollHandle | null {
  return ref && typeof ref === 'object' ? ref.current : null;
}

/**
 * 当前会话的查找：范围是这个会话已加载的全部消息，不跨会话。
 * 命中数按消息的文字估算（不要求消息已渲染），渲染出来的消息以 DOM 为准并高亮；
 * 跳到还没渲染的消息时请列表把它滚进来，渲染后再精确定位。
 * 只有查找栏打开时才算文字：流式输出每 100ms 一次，平时不该为它多遍历一遍整个会话。
 */
export function useSessionFind(
  display: DisplayMessage[],
  hidden: ReadonlySet<string>,
  handleRef: Ref<TranscriptScrollHandle> | undefined,
  resetKey: string | null,
): void {
  const { open } = useFindScope(CHAT_FIND_SCOPE);
  const textCache = useRef(new Map<string, { sources: readonly string[]; text: string }>());
  const cacheKey = useRef(resetKey);
  if (cacheKey.current !== resetKey) {
    cacheKey.current = resetKey;
    textCache.current.clear();
  }

  const items = useMemo<FinderItem[]>(() => {
    if (!open) return [];
    return display
      .filter((item) => !hidden.has(item.id))
      .map((item) => ({ id: item.id, text: cachedVisibleItemText(item, textCache.current) }));
  }, [open, display, hidden]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const handleRefLatest = useRef(handleRef);
  handleRefLatest.current = handleRef;

  // 换会话重建：旧查找器 dispose 时清掉它留在页面上的高亮。
  const finder = useMemo(
    () =>
      new DomFinder({
        getRoot: () => handleOf(handleRefLatest.current)?.getRoot?.() ?? null,
        items: () => itemsRef.current,
        scrollToItem: (id) => handleOf(handleRefLatest.current)?.scrollToItem?.(id),
        getScroller: () => handleOf(handleRefLatest.current)?.getScroller?.() ?? null,
        scrollBy: (delta) => handleOf(handleRefLatest.current)?.scrollBy(delta),
        onStatus: (status) => useFindStore.getState().setStatus(CHAT_FIND_SCOPE, status),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resetKey],
  );
  useFindDriver(CHAT_FIND_SCOPE, finder);

  // 消息变了（新消息、流式增长）：重算计数，当前项保持。
  useEffect(() => {
    if (open) finder.refresh();
  }, [items, finder, open]);

  // 只有挂着消息列表时才能查；换会话 / 列表卸载时关掉查找栏（它的结果属于上一个会话）。
  useEffect(() => registerFindScope(CHAT_FIND_SCOPE, () => true), []);
  const previousKey = useRef(resetKey);
  useEffect(() => {
    if (previousKey.current !== resetKey) {
      previousKey.current = resetKey;
      useFindStore.getState().close(CHAT_FIND_SCOPE);
    }
  }, [resetKey]);
  useEffect(() => () => useFindStore.getState().close(CHAT_FIND_SCOPE), []);
}
