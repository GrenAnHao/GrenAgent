import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pi, type SubAgentItem } from '../lib/pi';
import { selectSubAgentById, useSubAgentLiveStore } from './subagentLiveStore';

vi.mock('../lib/pi', () => ({ pi: { subagentList: vi.fn() } }));

const row = (id: string): SubAgentItem => ({ id, task: id, status: 'running', model: 'm', createdAt: 1, updatedAt: 1 });
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('subagentLiveStore', () => {
  const cleanups: Array<() => void> = [];
  const start = () => { cleanups.push(useSubAgentLiveStore.getState().startPolling('ws')); };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(pi.subagentList).mockReset();
    useSubAgentLiveStore.setState({ itemsByWorkspace: new Map() });
  });
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    vi.useRealTimers();
  });

  it('同一 workspace 共享一次轮询，无变化的回包不触发任何 store 通知', async () => {
    vi.mocked(pi.subagentList).mockImplementation(async () => [row('a'), row('b')]);
    start();
    start();
    await settle();
    const listener = vi.fn();
    const unsubscribe = useSubAgentLiveStore.subscribe(listener);
    await vi.advanceTimersByTimeAsync(2500);
    expect(pi.subagentList).toHaveBeenCalledTimes(2);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
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
