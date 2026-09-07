import { useCallback, useEffect, useRef, useState } from 'react';
import { agentDataApi, type MemoryFilter, type MemoryItem, type MemoryLevel, type MemoryListInput } from '../../lib/agentData';
interface Options { userId?: string; filter: MemoryFilter; query: string; level?: MemoryLevel; kind: 'memory' | 'conversation'; visible: boolean; reloadVersion?: number }
interface State { key: string; items: MemoryItem[]; nextCursor?: string; loading: boolean; refreshing: boolean; loaded: boolean; error?: string }

export function useMemoryBrowser({ userId = 'local', filter, query, level, kind, visible, reloadVersion = 0 }: Options) {
  const projectId = filter.scope === 'project' ? filter.projectId : undefined;
  const key = JSON.stringify([userId, filter.scope, projectId, query, kind, kind === 'memory' ? level : undefined]);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [state, setState] = useState<State>({ key, items: [], loading: false, refreshing: false, loaded: false });
  const current = useRef({ key, visible, epoch: 0, inFlight: false, loadedPageCount: 1 });
  // Invalidate at input change, not after the search debounce has fired.
  if (current.current.key !== key || current.current.visible !== visible) {
    current.current = { key, visible, epoch: current.current.epoch + 1, inFlight: false, loadedPageCount: current.current.key === key ? current.current.loadedPageCount : 1 };
  }
  const snapshot = useRef(state);
  snapshot.current = state;
  const requestPage = useRef<(cursor?: string) => void>(() => {});

  useEffect(() => {
    const runtime = current.current;
    const epoch = ++runtime.epoch;
    runtime.inFlight = false;
    const isCurrent = () => current.current === runtime && runtime.epoch === epoch && runtime.visible;
    const changed = snapshot.current.key !== key;
    setState((previous) => changed
      ? { key, items: [], loading: visible, refreshing: false, loaded: false }
      : { ...previous, loading: visible && !previous.loaded, refreshing: visible && previous.loaded, error: undefined });
    if (!visible) return;

    const input: MemoryListInput = {
      userId, filter: filter.scope === 'project' ? { scope: 'project', projectId: projectId! } : { scope: filter.scope }, limit: 50,
      ...(query.trim() ? { query: query.trim() } : {}),
      ...(kind === 'memory' && level !== undefined ? { level } : {}),
    };
    const fetchPage = async (cursor?: string) => {
      if (!isCurrent() || runtime.inFlight) return;
      runtime.inFlight = true;
      setState((previous) => ({ ...previous, loading: !previous.loaded, refreshing: previous.loaded, error: undefined }));
      try {
        const pageCount = cursor ? 1 : runtime.loadedPageCount;
        const items: MemoryItem[] = [];
        let nextCursor = cursor;
        let fetchedPages = 0;
        // Refresh the loaded window from fresh cursors, then replace it atomically.
        do {
          const args = { ...input, ...(nextCursor ? { cursor: nextCursor } : {}) };
          if (kind === 'memory') {
            const page = await agentDataApi.memory.list(args);
            if (!isCurrent()) return;
            items.push(...page.items.map((record): MemoryItem => ({ kind: 'memory', record })));
            nextCursor = page.nextCursor;
          } else {
            const page = await agentDataApi.memory.conversations.list(args);
            if (!isCurrent()) return;
            items.push(...page.items.map((record): MemoryItem => ({ kind: 'conversation', record })));
            nextCursor = page.nextCursor;
          }
          fetchedPages++;
        } while (fetchedPages < pageCount && nextCursor);
        runtime.loadedPageCount = cursor ? runtime.loadedPageCount + 1 : fetchedPages;
        setState((previous) => {
          const combined = cursor ? [...previous.items, ...items] : items;
          const ids = new Set<string>();
          return { key, items: combined.filter((item) => { const id = `${item.kind}:${item.record.id}`; if (ids.has(id)) return false; ids.add(id); return true; }), nextCursor, loading: false, refreshing: false, loaded: true };
        });
      } catch (cause) {
        if (isCurrent()) setState((previous) => ({ ...previous, loading: false, refreshing: false, error: cause instanceof Error ? cause.message : String(cause) }));
      } finally { if (isCurrent()) runtime.inFlight = false; }
    };
    requestPage.current = (cursor) => { void fetchPage(cursor); };
    const timer = query.trim() ? setTimeout(() => { void fetchPage(); }, 300) : undefined;
    if (!query.trim()) void fetchPage();
    return () => { clearTimeout(timer); runtime.epoch++; runtime.inFlight = false; };
  }, [key, visible, reloadVersion, refreshVersion]);

  const loadMore = useCallback(() => {
    const previous = snapshot.current;
    if (current.current.visible && !previous.loading && !previous.refreshing && previous.key === current.current.key && previous.nextCursor) requestPage.current(previous.nextCursor);
  }, []);
  const refresh = useCallback(() => {
    current.current.epoch++;
    setRefreshVersion((version) => version + 1);
  }, []);
  const result = state.key === key ? state : { key, items: [], loading: visible, refreshing: false, loaded: false };
  return { ...result, loadMore, refresh };
}
