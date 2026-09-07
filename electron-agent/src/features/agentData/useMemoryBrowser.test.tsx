// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedMemoryRecord, MemoryFilter, MemoryPage } from '../../lib/agentData';
import { agentDataApi } from '../../lib/agentData';
import { useMemoryBrowser } from './useMemoryBrowser';
import { conversationRecord, deferred, memoryRecord } from './memoryTestData';

vi.mock('../../lib/agentData', () => ({ agentDataApi: { memory: { list: vi.fn(), conversations: { list: vi.fn() } } } }));
const base = { filter: { scope: 'all' } as MemoryFilter, query: '', kind: 'memory' as const, visible: true, reloadVersion: 0 };
const flush = () => act(async () => { await Promise.resolve(); });

describe('useMemoryBrowser', () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.resetAllMocks();
    vi.mocked(agentDataApi.memory.list).mockResolvedValue({ items: [memoryRecord], nextCursor: 'next' });
    vi.mocked(agentDataApi.memory.conversations.list).mockResolvedValue({ items: [conversationRecord] });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });
  it('loads the recent first page immediately with local identity and tracks successful emptiness', async () => {
    vi.mocked(agentDataApi.memory.list).mockResolvedValueOnce({ items: [] });
    const { result } = renderHook(() => useMemoryBrowser(base));
    expect(result.current.loaded).toBe(false);
    expect(agentDataApi.memory.list).toHaveBeenCalledWith({ userId: 'local', filter: { scope: 'all' }, limit: 50 });
    await flush(); expect(result.current.loaded).toBe(true); expect(result.current.items).toEqual([]);
  });
  it('debounces search at 300ms and invalidates an earlier response before the delay ends', async () => {
    const stale = deferred<MemoryPage<ManagedMemoryRecord>>();
    vi.mocked(agentDataApi.memory.list).mockReturnValueOnce(stale.promise);
    const { result, rerender } = renderHook((query) => useMemoryBrowser({ ...base, query }), { initialProps: '' });
    rerender('中文');
    await act(async () => { stale.resolve({ items: [{ ...memoryRecord, content: '过期' }], nextCursor: 'old' }); });
    expect(result.current.items).toEqual([]); expect(result.current.nextCursor).toBeUndefined();
    await act(async () => { vi.advanceTimersByTime(299); });
    expect(agentDataApi.memory.list).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(agentDataApi.memory.list).toHaveBeenLastCalledWith({ userId: 'local', filter: { scope: 'all' }, query: '中文', limit: 50 });
    expect(result.current.items[0].record.id).toBe(memoryRecord.id);
  });
  it('ignores stale rejects and clears rows and cursors on domain changes', async () => {
    const stale = deferred<MemoryPage<ManagedMemoryRecord>>();
    const { result, rerender } = renderHook((filter: MemoryFilter) => useMemoryBrowser({ ...base, filter }), { initialProps: base.filter });
    await flush();
    vi.mocked(agentDataApi.memory.list).mockReturnValueOnce(stale.promise);
    act(() => result.current.loadMore());
    vi.mocked(agentDataApi.memory.list).mockRejectedValueOnce(new Error('new project failed'));
    rerender({ scope: 'project', projectId: 'D:/other' });
    await flush();
    expect(result.current.items).toEqual([]); expect(result.current.nextCursor).toBeUndefined();
    await act(async () => stale.reject(new Error('stale page failed')));
    expect(result.current.error).toBe('new project failed'); expect(result.current.loaded).toBe(false);
  });
  it('deduplicates concurrent load-more calls and ids while appending in order', async () => {
    const page = deferred<MemoryPage<ManagedMemoryRecord>>();
    const { result } = renderHook(() => useMemoryBrowser(base));
    await flush(); vi.mocked(agentDataApi.memory.list).mockReturnValueOnce(page.promise);
    act(() => { result.current.loadMore(); result.current.loadMore(); });
    expect(agentDataApi.memory.list).toHaveBeenCalledTimes(2);
    expect(agentDataApi.memory.list).toHaveBeenLastCalledWith({ userId: 'local', filter: { scope: 'all' }, limit: 50, cursor: 'next' });
    await act(async () => page.resolve({ items: [memoryRecord, { ...memoryRecord, id: 'memory-2' }] }));
    expect(result.current.items.map((item) => item.record.id)).toEqual(['memory-1', 'memory-2']);
  });
  it('does not repeat requests for semantically identical filter objects', async () => {
    const { rerender } = renderHook((filter: MemoryFilter) => useMemoryBrowser({ ...base, filter }), { initialProps: { scope: 'project', projectId: 'D:/one' } as MemoryFilter });
    await flush(); rerender({ scope: 'project', projectId: 'D:/one' }); await flush();
    expect(agentDataApi.memory.list).toHaveBeenCalledTimes(1);
  });
  it('pauses hidden queries, ignores late hidden results, and resumes latest filters once', async () => {
    const stale = deferred<MemoryPage<ManagedMemoryRecord>>();
    vi.mocked(agentDataApi.memory.list).mockReturnValueOnce(stale.promise);
    const { result, rerender } = renderHook((props: { visible: boolean; query: string }) => useMemoryBrowser({ ...base, ...props }), { initialProps: { visible: true, query: '' } });
    rerender({ visible: false, query: '最新' });
    await act(async () => { stale.resolve({ items: [memoryRecord] }); vi.advanceTimersByTime(1000); });
    expect(agentDataApi.memory.list).toHaveBeenCalledTimes(1); expect(result.current.items).toEqual([]);
    rerender({ visible: true, query: '最新' });
    await act(async () => vi.advanceTimersByTime(300));
    expect(agentDataApi.memory.list).toHaveBeenCalledTimes(2);
    rerender({ visible: true, query: '最新' }); await flush();
    expect(agentDataApi.memory.list).toHaveBeenCalledTimes(2);
  });
  it('retains loaded data on refresh failure and switches to read-only conversations', async () => {
    const { result, rerender } = renderHook((kind: 'memory' | 'conversation') => useMemoryBrowser({ ...base, kind }), { initialProps: 'memory' as 'memory' | 'conversation' });
    await flush(); vi.mocked(agentDataApi.memory.list).mockRejectedValueOnce(new Error('offline'));
    act(() => result.current.refresh()); await flush();
    expect(result.current.items).toHaveLength(1); expect(result.current.loaded).toBe(true); expect(result.current.error).toBe('offline');
    rerender('conversation'); await flush();
    expect(result.current.items[0]).toEqual({ kind: 'conversation', record: conversationRecord });
  });
  it('never uses the previous page cursor while a debounced refresh is pending', async () => {
    const { result } = renderHook(() => useMemoryBrowser({ ...base, query: '关键词' }));
    await act(async () => vi.advanceTimersByTime(300));
    expect(result.current.nextCursor).toBe('next');
    act(() => { result.current.refresh(); result.current.loadMore(); });
    expect(agentDataApi.memory.list).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(300));
    expect(agentDataApi.memory.list).toHaveBeenLastCalledWith({ userId: 'local', filter: { scope: 'all' }, query: '关键词', limit: 50 });
  });
  it.each(['visibility', 'reloadVersion', 'refresh'] as const)('refreshes the entire loaded window with fresh cursors after %s', async (reason) => {
    const oldSecond = { ...memoryRecord, id: 'old-second' };
    const freshFirst = { ...memoryRecord, id: 'fresh-first' };
    const freshSecond = { ...memoryRecord, id: 'fresh-second' };
    const pendingSecond = deferred<MemoryPage<ManagedMemoryRecord>>();
    vi.mocked(agentDataApi.memory.list)
      .mockResolvedValueOnce({ items: [memoryRecord], nextCursor: 'old-first-cursor' })
      .mockResolvedValueOnce({ items: [oldSecond], nextCursor: 'old-second-cursor' });
    const { result, rerender } = renderHook((props: { visible: boolean; reloadVersion: number }) => useMemoryBrowser({ ...base, query: '关键词', ...props }), { initialProps: { visible: true, reloadVersion: 0 } });
    await act(async () => vi.advanceTimersByTime(300));
    act(() => result.current.loadMore()); await flush();
    expect(result.current.items.map((item) => item.record.id)).toEqual([memoryRecord.id, oldSecond.id]);
    vi.mocked(agentDataApi.memory.list)
      .mockResolvedValueOnce({ items: [freshFirst], nextCursor: 'fresh-first-cursor' })
      .mockReturnValueOnce(pendingSecond.promise);
    if (reason === 'visibility') {
      rerender({ visible: false, reloadVersion: 0 }); await act(async () => vi.advanceTimersByTime(1000));
      expect(agentDataApi.memory.list).toHaveBeenCalledTimes(2);
      rerender({ visible: true, reloadVersion: 0 });
    } else if (reason === 'reloadVersion') rerender({ visible: true, reloadVersion: 1 });
    else act(() => result.current.refresh());
    await act(async () => vi.advanceTimersByTime(300));
    expect(agentDataApi.memory.list).toHaveBeenLastCalledWith({ userId: 'local', filter: { scope: 'all' }, query: '关键词', limit: 50, cursor: 'fresh-first-cursor' });
    expect(result.current.items.map((item) => item.record.id)).toEqual([memoryRecord.id, oldSecond.id]);
    expect(result.current.refreshing).toBe(true);
    await act(async () => pendingSecond.resolve({ items: [freshSecond], nextCursor: 'fresh-second-cursor' }));
    expect(result.current.items.map((item) => item.record.id)).toEqual([freshFirst.id, freshSecond.id]);
    expect(result.current.nextCursor).toBe('fresh-second-cursor');
    vi.mocked(agentDataApi.memory.list).mockResolvedValueOnce({ items: [freshSecond, { ...memoryRecord, id: 'third-page' }] });
    act(() => result.current.loadMore()); await flush();
    expect(agentDataApi.memory.list).toHaveBeenLastCalledWith({ userId: 'local', filter: { scope: 'all' }, query: '关键词', limit: 50, cursor: 'fresh-second-cursor' });
    expect(result.current.items.map((item) => item.record.id)).toEqual([freshFirst.id, freshSecond.id, 'third-page']);
  });
  it('retains the complete old window and cursor when a refreshed second page fails', async () => {
    const second = { ...memoryRecord, id: 'second-page' };
    vi.mocked(agentDataApi.memory.list)
      .mockResolvedValueOnce({ items: [memoryRecord], nextCursor: 'page-one' })
      .mockResolvedValueOnce({ items: [second], nextCursor: 'page-two' });
    const { result } = renderHook(() => useMemoryBrowser(base)); await flush();
    act(() => result.current.loadMore()); await flush();
    vi.mocked(agentDataApi.memory.list)
      .mockResolvedValueOnce({ items: [{ ...memoryRecord, content: '不能部分替换' }], nextCursor: 'fresh-one' })
      .mockRejectedValueOnce(new Error('second page unavailable'));
    act(() => result.current.refresh()); await flush();
    expect(result.current.error).toBe('second page unavailable');
    expect(result.current.items.map((item) => item.record)).toEqual([memoryRecord, second]);
    expect(result.current.nextCursor).toBe('page-two');
    vi.mocked(agentDataApi.memory.list)
      .mockResolvedValueOnce({ items: [memoryRecord], nextCursor: 'retry-first' })
      .mockResolvedValueOnce({ items: [second], nextCursor: 'retry-second' });
    act(() => result.current.refresh()); await flush();
    expect(result.current.nextCursor).toBe('retry-second');
  });
  it.each(['resolve', 'reject'] as const)('discards a refreshed page chain on filter changes before its stale second page can %s', async (settlement) => {
    const pending = deferred<MemoryPage<ManagedMemoryRecord>>();
    const newRecord = { ...memoryRecord, id: 'new-project-record' };
    vi.mocked(agentDataApi.memory.list)
      .mockResolvedValueOnce({ items: [memoryRecord], nextCursor: 'old-first' })
      .mockResolvedValueOnce({ items: [{ ...memoryRecord, id: 'old-second' }], nextCursor: 'old-second' });
    const { result, rerender } = renderHook((filter: MemoryFilter) => useMemoryBrowser({ ...base, filter }), { initialProps: base.filter });
    await flush(); act(() => result.current.loadMore()); await flush();
    vi.mocked(agentDataApi.memory.list)
      .mockResolvedValueOnce({ items: [memoryRecord], nextCursor: 'fresh-chain' })
      .mockReturnValueOnce(pending.promise);
    act(() => result.current.refresh()); await flush();
    expect(agentDataApi.memory.list).toHaveBeenLastCalledWith({ userId: 'local', filter: { scope: 'all' }, limit: 50, cursor: 'fresh-chain' });
    vi.mocked(agentDataApi.memory.list).mockResolvedValueOnce({ items: [newRecord], nextCursor: 'new-project-next' });
    rerender({ scope: 'project', projectId: 'D:/different' }); await flush();
    await act(async () => {
      if (settlement === 'resolve') pending.resolve({ items: [{ ...memoryRecord, id: 'stale-second' }], nextCursor: 'stale-third' });
      else pending.reject(new Error('stale chain failed'));
    });
    expect(result.current.items.map((item) => item.record.id)).toEqual([newRecord.id]);
    expect(result.current.error).toBeUndefined(); expect(result.current.nextCursor).toBe('new-project-next');
    const calls = vi.mocked(agentDataApi.memory.list).mock.calls.length;
    vi.mocked(agentDataApi.memory.list).mockResolvedValueOnce({ items: [newRecord], nextCursor: 'new-project-refreshed' });
    act(() => result.current.refresh()); await flush();
    expect(agentDataApi.memory.list).toHaveBeenCalledTimes(calls + 1);
  });
  it('stops a refreshed chain when hidden before its first response and resumes the same page count', async () => {
    const second = { ...memoryRecord, id: 'second-page' };
    const pending = deferred<MemoryPage<ManagedMemoryRecord>>();
    vi.mocked(agentDataApi.memory.list)
      .mockResolvedValueOnce({ items: [memoryRecord], nextCursor: 'old-first' })
      .mockResolvedValueOnce({ items: [second], nextCursor: 'old-second' });
    const { result, rerender } = renderHook((visible: boolean) => useMemoryBrowser({ ...base, visible }), { initialProps: true });
    await flush(); act(() => result.current.loadMore()); await flush();
    vi.mocked(agentDataApi.memory.list).mockReturnValueOnce(pending.promise);
    act(() => result.current.refresh()); rerender(false);
    await act(async () => pending.resolve({ items: [], nextCursor: 'must-not-follow' }));
    expect(agentDataApi.memory.list).toHaveBeenCalledTimes(3);
    expect(result.current.items.map((item) => item.record.id)).toEqual([memoryRecord.id, second.id]);
    vi.mocked(agentDataApi.memory.list)
      .mockResolvedValueOnce({ items: [memoryRecord], nextCursor: 'resume-first' })
      .mockResolvedValueOnce({ items: [second], nextCursor: 'resume-second' });
    rerender(true); await flush();
    expect(agentDataApi.memory.list).toHaveBeenCalledTimes(5);
    expect(result.current.nextCursor).toBe('resume-second');
  });
  it('ends the refreshed window early when fresh data runs out', async () => {
    vi.mocked(agentDataApi.memory.list)
      .mockResolvedValueOnce({ items: [memoryRecord], nextCursor: 'old-first' })
      .mockResolvedValueOnce({ items: [{ ...memoryRecord, id: 'removed-second' }] });
    const { result } = renderHook(() => useMemoryBrowser(base)); await flush();
    act(() => result.current.loadMore()); await flush();
    vi.mocked(agentDataApi.memory.list).mockResolvedValueOnce({ items: [memoryRecord] });
    act(() => result.current.refresh()); await flush();
    expect(agentDataApi.memory.list).toHaveBeenCalledTimes(3);
    expect(result.current.items.map((item) => item.record.id)).toEqual([memoryRecord.id]);
    expect(result.current.nextCursor).toBeUndefined();
  });
});
