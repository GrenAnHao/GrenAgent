// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGoalStore, type GoalSnapshot } from '../../../stores/goalStore';

const { getState, goalGet, goalUpdate, goalHistory } = vi.hoisted(() => ({
  getState: vi.fn(),
  goalGet: vi.fn(),
  goalUpdate: vi.fn(),
  goalHistory: vi.fn(),
}));
let activeSessionPath: string | null = '/sessions/a.jsonl';

vi.mock('../../../lib/pi', () => ({ pi: { getState } }));
vi.mock('../../../lib/agentData', () => ({
  agentDataApi: { goals: { get: goalGet, update: goalUpdate, history: goalHistory } },
}));
vi.mock('../../../store/session', () => ({
  useSessionStore: (selector: (state: { activeSessionPath: string | null }) => unknown) =>
    selector({ activeSessionPath }),
}));
vi.mock('../../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/repo' }),
}));

import { GoalPill } from './GoalPill';

// jsdom has no ResizeObserver, and the Goal detail drawer observes its own size.
if (!('ResizeObserver' in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

const makeSnapshot = (overrides: Partial<GoalSnapshot> = {}): GoalSnapshot => ({
  goalId: 'goal-a',
  sessionId: 'session-a',
  workspace: '/repo',
  revision: 2,
  condition: '写完测试',
  status: 'active',
  roundsUsed: 3,
  maxRounds: 256,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:01.000Z',
  ...overrides,
});

beforeEach(() => {
  useGoalStore.setState({ bySession: {}, goal: undefined });
  activeSessionPath = '/sessions/a.jsonl';
  getState.mockResolvedValue({ sessionFile: '/sessions/a.jsonl', sessionId: 'session-a' });
  goalGet.mockResolvedValue(makeSnapshot());
  goalUpdate.mockImplementation(async (input: { action: string }) => makeSnapshot({
    status: input.action === 'pause' ? 'paused' : 'active',
    revision: 3,
  }));
  goalHistory.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  getState.mockReset();
  goalGet.mockReset();
  goalUpdate.mockReset();
  goalHistory.mockReset();
});

describe('GoalPill', () => {
  it('loads and renders only the active session goal', async () => {
    render(<GoalPill />);

    expect(await screen.findByText('写完测试')).toBeTruthy();
    expect(goalGet).toHaveBeenCalledWith('session-a', '/repo');
    expect(screen.getByText('执行中')).toBeTruthy();
  });

  it('sends a typed pause update with the session CAS reference', async () => {
    render(<GoalPill />);
    await screen.findByText('写完测试');

    fireEvent.click(screen.getByRole('button', { name: '暂停目标' }));

    await waitFor(() => expect(goalUpdate).toHaveBeenCalledWith({
      sessionId: 'session-a',
      goalId: 'goal-a',
      revision: 2,
      action: 'pause',
    }));
  });

  it('edits through the in-session drawer and typed CAS updates', async () => {
    render(<GoalPill />);
    await screen.findByText('写完测试');

    fireEvent.click(screen.getByRole('button', { name: '修改目标' }));
    const input = await screen.findByRole('textbox', { name: '目标条件' });
    fireEvent.change(input, { target: { value: '新目标' } });
    fireEvent.click(screen.getByRole('button', { name: '保存目标' }));

    await waitFor(() => expect(goalUpdate).toHaveBeenCalledTimes(2));
    expect(goalUpdate.mock.calls[0][0]).toMatchObject({
      sessionId: 'session-a', goalId: 'goal-a', revision: 2, action: 'pause', payload: { condition: '新目标' },
    });
    expect(goalUpdate.mock.calls[1][0]).toMatchObject({
      sessionId: 'session-a', goalId: 'goal-a', revision: 3, action: 'resume', payload: { condition: '新目标' },
    });
  });

  it('offers resume for a blocked goal and shows its blockage count', async () => {
    goalGet.mockResolvedValue(makeSnapshot({
      status: 'blocked',
      blockage: { fingerprint: 'wait', count: 3, summary: '等待外部依赖', at: '2026-09-01T00:00:00.000Z' },
    }));
    render(<GoalPill />);

    expect(await screen.findByText('业务阻塞 · 3 次')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '解除阻塞并恢复' }));
    await waitFor(() => expect(goalUpdate).toHaveBeenCalledWith(expect.objectContaining({ action: 'resume' })));
  });

  it('keeps judging and complete goals read-only', async () => {
    goalGet.mockResolvedValue(makeSnapshot({ status: 'judging' }));
    render(<GoalPill />);
    await screen.findByText('正在验收');
    expect(screen.queryByRole('button', { name: '暂停目标' })).toBeNull();
    expect(screen.queryByRole('button', { name: '修改目标' })).toBeNull();
    expect(screen.queryByRole('button', { name: '清除目标' })).toBeNull();
  });

  it('does not render a goal while the active session has no snapshot', async () => {
    goalGet.mockResolvedValue(undefined);
    render(<GoalPill />);
    await waitFor(() => expect(goalGet).toHaveBeenCalled());
    expect(screen.queryByTestId('goal-pill')).toBeNull();
  });
});
