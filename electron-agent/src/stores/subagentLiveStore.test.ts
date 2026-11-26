import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pi, type SubAgentItem } from '../lib/pi';
import { observationKey, selectSubAgentById, selectSubAgentList, subAgentObservationUnconfirmed, useSubAgentLiveStore } from './subagentLiveStore';

vi.mock('../lib/pi', () => ({ pi: { subagentList: vi.fn(), subagentLookup: vi.fn() } }));

const parentA = '/s/2026-10-04T00-00-00-000Z_sid-a.jsonl';
const parentB = '/s/2026-10-04T00-00-00-000Z_sid-b.jsonl';
type FoundItem = Extract<Awaited<ReturnType<typeof pi.subagentLookup>>, { kind: 'found' }>['item'];
const item = (status: FoundItem['status'], updatedAt = 1): FoundItem => ({
  id: 'child', responseStarted: 0, task: 'same task', status, model: null, thinkingLevel: null, sessionPath: '/s/child.jsonl',
  profile: null, output: null, error: null, exitCode: null, transcript: null, createdAt: 1, updatedAt,
});
const snapshot = (parent = parentA) => useSubAgentLiveStore.getState().observations.get(observationKey('ws', parent, 'child'));

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(pi.subagentList).mockResolvedValue([]);
  vi.mocked(pi.subagentLookup).mockResolvedValue({ kind: 'not-found' });
  useSubAgentLiveStore.setState({ observations: new Map(), itemsByWorkspace: new Map(), listQueries: new Map() });
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const row = (id: string): SubAgentItem => ({ id, task: id, status: 'running', model: 'm', createdAt: 1, updatedAt: 1 });
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('subagentLiveStore existing list behavior', () => {
  const cleanups: Array<() => void> = [];
  const start = () => { cleanups.push(useSubAgentLiveStore.getState().startPolling('ws')); };
  afterEach(() => { for (const release of cleanups.splice(0)) release(); });

  it('同一 workspace 共享一次轮询，无变化的回包保持行对象引用', async () => {
    vi.mocked(pi.subagentList).mockImplementation(async () => [row('a'), row('b')]);
    start(); start();
    await settle();
    const before = useSubAgentLiveStore.getState().itemsByWorkspace.get('ws');
    await vi.advanceTimersByTimeAsync(2500);
    expect(pi.subagentList).toHaveBeenCalledTimes(2);
    expect(useSubAgentLiveStore.getState().itemsByWorkspace.get('ws')).toBe(before);
  });

  it('只有变化的子代理替换对象，其他卡片订阅的对象保持引用', async () => {
    vi.mocked(pi.subagentList).mockResolvedValueOnce([row('a'), row('b')])
      .mockResolvedValueOnce([{ ...row('a'), status: 'done', updatedAt: 2 }, row('b')]);
    start();
    await settle();
    const selectA = selectSubAgentById('ws', 'a');
    const selectB = selectSubAgentById('ws', 'b');
    const a = selectA(useSubAgentLiveStore.getState());
    const b = selectB(useSubAgentLiveStore.getState());
    await vi.advanceTimersByTimeAsync(2500);
    expect(selectA(useSubAgentLiveStore.getState())).not.toBe(a);
    expect(selectB(useSubAgentLiveStore.getState())).toBe(b);
  });

  it('上次请求没返回时不叠加查询，最后一个消费者离开后忽略迟到回包', async () => {
    let resolve: (items: SubAgentItem[]) => void = () => {};
    vi.mocked(pi.subagentList).mockReturnValue(new Promise((r) => { resolve = r; }));
    start();
    await vi.advanceTimersByTimeAsync(7500);
    expect(pi.subagentList).toHaveBeenCalledTimes(1);
    cleanups.pop()!();
    resolve([row('a')]);
    await settle();
    expect(useSubAgentLiveStore.getState().itemsByWorkspace.has('ws')).toBe(false);
  });
});

describe('owned subagent observation', () => {
  it('does not treat a stale empty list or repeated missing ID as interrupted; backoff recovers late registration', async () => {
    const releaseList = useSubAgentLiveStore.getState().startPolling('ws');
    await vi.advanceTimersByTimeAsync(1);
    const release = useSubAgentLiveStore.getState().watch('ws', parentA, 'child');
    await vi.advanceTimersByTimeAsync(10001);
    expect(snapshot()).toMatchObject({ attempts: 3, state: 'not-found' });
    expect(pi.subagentLookup).toHaveBeenCalledWith('ws', 'child', parentA);
    const calls = vi.mocked(pi.subagentLookup).mock.calls.length;
    await vi.advanceTimersByTimeAsync(2501);
    expect(pi.subagentLookup).toHaveBeenCalledTimes(calls);
    vi.mocked(pi.subagentLookup).mockResolvedValue({ kind: 'found', item: item('running') });
    await vi.advanceTimersByTimeAsync(10001);
    expect(snapshot()).toMatchObject({ attempts: 0, state: 'found', item: { status: 'running' } });
    release(); releaseList();
    expect(snapshot()?.item?.status).toBe('running');
  });

  it('running entry lost after a successful lookup becomes unconfirmed and auto-recovers', async () => {
    vi.mocked(pi.subagentLookup).mockResolvedValueOnce({ kind: 'found', item: item('running') });
    const release = useSubAgentLiveStore.getState().watch('ws', parentA, 'child');
    await vi.advanceTimersByTimeAsync(1);
    expect(snapshot()?.item?.status).toBe('running');
    vi.mocked(pi.subagentLookup).mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    await vi.advanceTimersByTimeAsync(15001);
    expect(snapshot()).toMatchObject({ attempts: 3, state: 'not-found', item: { status: 'running' } });
    expect(subAgentObservationUnconfirmed(snapshot()!)).toBe(true);
    const calls = vi.mocked(pi.subagentLookup).mock.calls.length;
    await vi.advanceTimersByTimeAsync(2501);
    expect(pi.subagentLookup).toHaveBeenCalledTimes(calls);
    vi.mocked(pi.subagentLookup).mockResolvedValue({ kind: 'found', item: item('done', 2) });
    await vi.advanceTimersByTimeAsync(5001);
    expect(snapshot()?.item?.status).toBe('done');
    expect(subAgentObservationUnconfirmed(snapshot()!)).toBe(false);
    release();
  });

  it('falls back to owner-scoped list only when a hot-reloaded renderer sees an old main IPC bundle', async () => {
    vi.mocked(pi.subagentLookup).mockRejectedValue(new Error('Electron command is not registered: subagent_lookup'));
    vi.mocked(pi.subagentList).mockResolvedValue([item('running')]);
    const release = useSubAgentLiveStore.getState().watch('ws', parentA, 'child');
    await vi.advanceTimersByTimeAsync(1);
    expect(pi.subagentList).toHaveBeenCalledWith('ws', parentA);
    expect(snapshot()).toMatchObject({ state: 'found', item: { id: 'child', status: 'running' } });
    release();
  });

  it('merges parent-confirmed ID beyond a 50-row list and never downgrades terminal to stale running', () => {
    const rows = Array.from({ length: 50 }, (_, n) => row(`row-${n}`));
    const terminal = item('done', 10);
    useSubAgentLiveStore.setState({ itemsByWorkspace: new Map([['ws', rows]]), observations: new Map([
      [observationKey('ws', parentA, 'child'), { generation: 1, attempts: 0, state: 'found', item: terminal }],
    ]) });
    const select = selectSubAgentList('ws');
    const first = select(useSubAgentLiveStore.getState());
    expect(first).toHaveLength(51);
    expect(first.filter((entry) => entry.id === 'child')).toEqual([terminal]);
    expect(select(useSubAgentLiveStore.getState())).toBe(first);
    useSubAgentLiveStore.setState({ itemsByWorkspace: new Map([['ws', [row('child'), ...rows.slice(0, 49)]]] ) });
    expect(select(useSubAgentLiveStore.getState())).toHaveLength(50);
    expect(selectSubAgentById('ws', 'child')(useSubAgentLiveStore.getState())).toBe(terminal);
    expect(select(useSubAgentLiveStore.getState()).find((entry) => entry.id === 'child')).toBe(terminal);
  });

  it('isolates parent owners and ignores older running/empty responses after terminal', async () => {
    vi.mocked(pi.subagentLookup).mockImplementation(async (_ws, _id, parent) => parent === parentA
      ? { kind: 'found', item: item('done', 10) } : { kind: 'not-found' });
    const releaseA = useSubAgentLiveStore.getState().watch('ws', parentA, 'child');
    const releaseB = useSubAgentLiveStore.getState().watch('ws', parentB, 'child');
    await vi.advanceTimersByTimeAsync(2501);
    expect(snapshot(parentA)?.item?.status).toBe('done');
    expect(snapshot(parentB)?.item).toBeUndefined();
    releaseA(); releaseB();
    const remount = useSubAgentLiveStore.getState().watch('ws', parentA, 'child');
    vi.mocked(pi.subagentLookup).mockResolvedValue({ kind: 'found', item: item('running', 9) });
    await vi.advanceTimersByTimeAsync(2501);
    expect(snapshot(parentA)?.item?.status).toBe('done');
    remount();
  });
});
