import { afterEach, describe, expect, it, vi } from 'vitest';

const { listRunningTurns } = vi.hoisted(() => ({ listRunningTurns: vi.fn() }));
vi.mock('../lib/pi', () => ({
  pi: { listRunningTurns, getState: vi.fn(async () => ({})) },
  onPiEvent: () => Promise.resolve(() => {}),
  onPiExit: () => Promise.resolve(() => {}),
}));

import { loadRunningTurns, planRunningRestore, restoreRunningTurns, restoredRunStartedAt, type RunningTurn } from './restoreRunningTurns';
import { handleRunningEvent, resetRunningSessionsForTest } from './runningSessions';
import { useAgentRegistryStore } from './agentStoreRegistry';

const live: RunningTurn = { workspace: '/proj', sessionId: 's1', sessionPath: '/proj/s1.jsonl' };

describe('planRunningRestore', () => {
  it('keeps a turn whose stream epoch did not move during the snapshot', () => {
    const epochs = new Map([['/proj', 2]]);
    expect(planRunningRestore([live], epochs, () => 2)).toEqual([live]);
  });

  it('drops a turn when agent_start or agent_end already landed', () => {
    const epochs = new Map([['/proj', 2]]);
    expect(planRunningRestore([live], epochs, () => 3)).toEqual([]);
  });

  it('keeps a workspace that had no store when the request started', () => {
    expect(planRunningRestore([live], new Map(), () => undefined)).toEqual([live]);
  });
});

describe('loadRunningTurns', () => {
  it('uses getState when the list command is not registered yet', async () => {
    const getState = vi.fn(async () => ({ isStreaming: true, sessionId: 's1', sessionFile: '/proj/s1.jsonl' }));
    await expect(loadRunningTurns(async () => {
      throw new Error('Electron command is not registered: agent_list_running_turns');
    }, getState, '/proj')).resolves.toEqual([live]);
    expect(getState).toHaveBeenCalledWith('/proj');
  });

  it('does not clear running state when getState also fails', async () => {
    await expect(loadRunningTurns(async () => {
      throw new Error('not registered');
    }, async () => {
      throw new Error('workspace not open');
    }, '/proj')).resolves.toBeNull();
  });
});

describe('restoredRunStartedAt', () => {
  it('用最后一条非引导的用户消息时间，没有就用现在', () => {
    expect(restoredRunStartedAt([
      { kind: 'user', id: 'a', text: '问题', timestamp: 1_000 },
      { kind: 'assistant', id: 'b', text: '', thinking: '', streaming: false },
      { kind: 'user', id: 'c', text: '引导', steering: true, timestamp: 2_000 },
    ], 9_000)).toBe(1_000);
    expect(restoredRunStartedAt([{ kind: 'user', id: 'a', text: '本地刚发' }], 9_000)).toBe(9_000);
    expect(restoredRunStartedAt([], 9_000)).toBe(9_000);
  });
});

describe('restoreRunningTurns', () => {
  afterEach(() => {
    resetRunningSessionsForTest();
    listRunningTurns.mockReset();
  });

  it('按主进程快照对账：跑完的会话熄灭，仍在跑的点亮', async () => {
    handleRunningEvent({ workspace: '/proj', sessionPath: '/proj/done.jsonl', event: { type: 'agent_start' } } as never);
    listRunningTurns.mockResolvedValue([live]);
    await restoreRunningTurns();
    expect(useAgentRegistryStore.getState().runningSessionPaths).toEqual(['/proj/s1.jsonl']);
  });

  it('等快照期间后台会话 agent_settled，过期快照不能把它重新点亮', async () => {
    let resolve!: (turns: RunningTurn[]) => void;
    listRunningTurns.mockReturnValue(new Promise<RunningTurn[]>((r) => { resolve = r; }));
    handleRunningEvent({ workspace: '/proj', sessionPath: '/proj/s1.jsonl', event: { type: 'agent_start' } } as never);
    const pending = restoreRunningTurns();
    handleRunningEvent({ workspace: '/proj', sessionPath: '/proj/s1.jsonl', event: { type: 'agent_settled' } } as never);
    resolve([live]);
    await pending;
    expect(useAgentRegistryStore.getState().runningSessionPaths).toEqual([]);
  });
});
