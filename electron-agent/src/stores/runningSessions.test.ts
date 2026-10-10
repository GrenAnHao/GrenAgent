import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/pi', () => ({
  onPiEvent: () => Promise.resolve(() => {}),
  onPiExit: () => Promise.resolve(() => {}),
}));

import {
  captureRunningEpochs,
  forgetRunningSession,
  handleRunningEvent,
  handleRunningExit,
  isSessionRunning,
  reconcileRunningSessions,
  resetRunningSessionsForTest,
  resolveRunningSessionPaths,
  workspacesMovedSince,
} from './runningSessions';
import { useAgentRegistryStore } from './agentStoreRegistry';

const WS = '/proj';
const A = '/proj/a.jsonl';
const B = '/proj/b.jsonl';

const ev = (sessionPath: string, event: Record<string, unknown>, source?: 'interactive' | 'goal' | 'subagent') => ({
  workspace: WS,
  sessionPath,
  event,
  ...(source ? { source } : {}),
}) as never;

const lit = () => useAgentRegistryStore.getState().runningSessionPaths;

afterEach(() => resetRunningSessionsForTest());

describe('runningSessions', () => {
  it('同项目两个会话各自点亮，后台 B 的 agent_settled 只熄灭 B', () => {
    handleRunningEvent(ev(A, { type: 'agent_start' }));
    handleRunningEvent(ev(B, { type: 'agent_start' }));
    expect(lit()).toEqual([A, B]);

    handleRunningEvent(ev(B, { type: 'agent_settled' }));
    expect(lit()).toEqual([A]);
    expect(isSessionRunning(B)).toBe(false);
    expect(isSessionRunning(A)).toBe(true);
  });

  it('agent_end 带 willRetry 时保持点亮，不重试才熄灭', () => {
    handleRunningEvent(ev(A, { type: 'agent_start' }));
    handleRunningEvent(ev(A, { type: 'agent_end', willRetry: true }));
    expect(lit()).toEqual([A]);
    handleRunningEvent(ev(A, { type: 'agent_end' }));
    expect(lit()).toEqual([]);
  });

  it('goal / subagent 事件不影响侧边栏', () => {
    handleRunningEvent(ev(A, { type: 'agent_start' }, 'goal'));
    handleRunningEvent(ev(A, { type: 'agent_start' }, 'subagent'));
    expect(lit()).toEqual([]);
  });

  it('pi://exit 带路径只熄灭那份，不带路径熄灭整个项目', () => {
    handleRunningEvent(ev(A, { type: 'agent_start' }));
    handleRunningEvent(ev(B, { type: 'agent_start' }));
    handleRunningExit({ workspace: WS, code: 0, sessionPath: A });
    expect(lit()).toEqual([B]);
    handleRunningExit({ workspace: WS, code: 1 });
    expect(lit()).toEqual([]);
  });

  it('快照对账：快照为准，等待期间有事件的 workspace 保留事件结果', () => {
    handleRunningEvent(ev(A, { type: 'agent_start' }));
    reconcileRunningSessions([{ workspace: WS, sessionPath: B }]);
    expect(lit()).toEqual([B]);

    const before = captureRunningEpochs();
    handleRunningEvent(ev(B, { type: 'agent_settled' }));
    const moved = workspacesMovedSince(before);
    expect(moved.has(WS)).toBe(true);
    // 过期快照仍说 B 在跑，但期间 B 已结束，不能再点亮。
    reconcileRunningSessions([{ workspace: WS, sessionPath: B }], moved);
    expect(lit()).toEqual([]);
  });

  it('会话被删后不论记在哪个 workspace 下都熄灭，等待中的旧快照也不能再点亮', () => {
    handleRunningEvent(ev(A, { type: 'agent_start' }));
    handleRunningEvent(ev(B, { type: 'agent_start' }));
    const before = captureRunningEpochs();

    // 拆掉停靠的 handle 时它的 agent_end 不再转发，只能靠删除侧主动熄灭。
    // 渲染层会话列表里的拼法可以和事件里的不同。
    forgetRunningSession('\\PROJ\\A.jsonl');
    expect(lit()).toEqual([B]);

    reconcileRunningSessions([{ workspace: WS, sessionPath: A }, { workspace: WS, sessionPath: B }], workspacesMovedSince(before));
    expect(lit()).toEqual([B]);
  });

  it('侧边栏集合只来自按路径的运行态，并换成会话列表里的写法', () => {
    const set = resolveRunningSessionPaths(['C:\\Proj\\A.jsonl'], [{ path: 'c:/proj/a.jsonl' }]);
    expect([...set]).toEqual(['c:/proj/a.jsonl']);
    // 跑完的会话不在集合里，哪怕同项目另一个会话还在跑。
    handleRunningEvent(ev(A, { type: 'agent_start' }));
    handleRunningEvent(ev(B, { type: 'agent_start' }));
    handleRunningEvent(ev(A, { type: 'agent_settled' }));
    const sidebar = resolveRunningSessionPaths(lit(), [{ path: A }, { path: B }]);
    expect(sidebar.has(A)).toBe(false);
    expect(sidebar.has(B)).toBe(true);
  });
});
