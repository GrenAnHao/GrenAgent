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
  markSessionStopped,
  reconcileRunningSessions,
  resetRunningSessionsForTest,
  resolveRunningSessionPaths,
  runningSessionKey,
  sessionsMovedSince,
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

  it('快照对账：快照为准，等待期间有事件的会话保留事件结果', () => {
    handleRunningEvent(ev(A, { type: 'agent_start' }));
    reconcileRunningSessions([{ workspace: WS, sessionPath: B }]);
    expect(lit()).toEqual([B]);

    const before = captureRunningEpochs();
    handleRunningEvent(ev(B, { type: 'agent_settled' }));
    const keepPaths = sessionsMovedSince(before);
    expect(keepPaths.has(runningSessionKey(WS, B))).toBe(true);
    // 过期快照仍说 B 在跑，但期间 B 已结束，不能再点亮。
    reconcileRunningSessions([{ workspace: WS, sessionPath: B }], new Set(), keepPaths);
    expect(lit()).toEqual([]);
  });

  it('同项目里另一个会话刚开始跑，不能保住陈旧会话的运行条目', () => {
    handleRunningEvent(ev(A, { type: 'agent_start' }));
    // A 跑完后终态事件丢了。B 开始只改变 B 自己的会话纪元，不再让整份快照作废。
    const before = captureRunningEpochs();
    handleRunningEvent(ev(B, { type: 'agent_start' }));
    expect(workspacesMovedSince(before).has(WS)).toBe(false);
    const keepPaths = sessionsMovedSince(before);
    expect(keepPaths.has(runningSessionKey(WS, A))).toBe(false);
    expect(keepPaths.has(runningSessionKey(WS, B))).toBe(true);

    // 快照里只有 B。按会话对账：A 这段等待期间没有新事件，必须熄灭。
    reconcileRunningSessions([{ workspace: WS, sessionPath: B }], new Set(), keepPaths);
    expect(lit()).toEqual([B]);
    expect(isSessionRunning(A)).toBe(false);
  });

  it('快照仍说在跑、但等待期间它自己已收尾：以事件为准熄灭', () => {
    handleRunningEvent(ev(A, { type: 'agent_start' }));
    const before = captureRunningEpochs();
    handleRunningEvent(ev(A, { type: 'agent_settled' }));
    const keepPaths = sessionsMovedSince(before);
    expect(keepPaths.has(runningSessionKey(WS, A))).toBe(true);
    reconcileRunningSessions([{ workspace: WS, sessionPath: A }], new Set(), keepPaths);
    expect(lit()).toEqual([]);
  });

  it('用户停掉的会话立刻熄灭，等待中的旧快照也不能再点亮', () => {
    handleRunningEvent(ev(A, { type: 'agent_start' }));
    const before = captureRunningEpochs();
    markSessionStopped(A);
    expect(lit()).toEqual([]);
    // 停止本身也计入会话纪元：过期快照不能凭「你没动过」把它重新点亮。
    const keepPaths = sessionsMovedSince(before);
    expect(keepPaths.has(runningSessionKey(WS, A))).toBe(true);
    reconcileRunningSessions([{ workspace: WS, sessionPath: A }], new Set(), keepPaths);
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

    reconcileRunningSessions(
      [{ workspace: WS, sessionPath: A }, { workspace: WS, sessionPath: B }],
      new Set(),
      sessionsMovedSince(before),
    );
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
