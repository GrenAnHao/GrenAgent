// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GoalEvent } from '../../../lib/agentData';
import type { GoalSnapshot } from '../../../stores/goalStore';

const { history, update } = vi.hoisted(() => ({ history: vi.fn(), update: vi.fn() }));
vi.mock('../../../lib/agentData', () => ({ agentDataApi: { goals: { history, update } } }));

// jsdom has no ResizeObserver, and the drawer's layout observes its own size.
if (!('ResizeObserver' in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

import { SessionGoalDrawer } from './SessionGoalDrawer';

const snapshot: GoalSnapshot = {
  goalId: 'goal-a', sessionId: 'session-a', workspace: '/repo', revision: 4,
  condition: '完成并通过测试', status: 'blocked', roundsUsed: 7, maxRounds: 12,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:01.000Z',
  stopReason: { kind: 'blocked', summary: '等待外部依赖', at: '2026-09-01T00:00:01.000Z' },
  blockage: { fingerprint: 'wait', count: 3, summary: '等待外部依赖', at: '2026-09-01T00:00:01.000Z' },
  judge: { model: 'judge/model', verdict: 'fail', reason: '缺少测试', missing: ['测试'], revision: 3, at: '2026-09-01T00:00:00.500Z' },
};

const event: GoalEvent = {
  id: 'event-1', goalId: 'goal-a', sessionId: 'session-a', revision: 4,
  kind: 'block', payload: { reason: '等待外部依赖' }, createdAt: '2026-09-01T00:00:01.000Z',
};

const activeSnapshot: GoalSnapshot = { ...snapshot, status: 'active', revision: 4 };

afterEach(() => {
  cleanup();
  history.mockReset();
  update.mockReset();
});

describe('SessionGoalDrawer', () => {
  it('shows session metadata, stop reason, judge, blockage, and recent events', async () => {
    history.mockResolvedValue([event]);
    render(<SessionGoalDrawer open onClose={vi.fn()} sessionId="session-a" snapshot={snapshot} />);

    expect(screen.getByText('完成并通过测试', { selector: 'p' })).toBeTruthy();
    expect(screen.getByText('session-a')).toBeTruthy();
    expect(screen.getByText('goal-a')).toBeTruthy();
    expect(screen.getByText('7 / 12')).toBeTruthy();
    expect(screen.getAllByText('等待外部依赖').length).toBeGreaterThan(0);
    expect(screen.getByText('缺少测试')).toBeTruthy();
    await waitFor(() => expect(history).toHaveBeenCalledWith('session-a'));
    expect(screen.getByText('block · r4')).toBeTruthy();
  });

  it('does not render a closed drawer or query history while closed', () => {
    render(<SessionGoalDrawer open={false} onClose={vi.fn()} sessionId="session-a" snapshot={snapshot} />);
    expect(screen.queryByText('完成并通过测试')).toBeNull();
    expect(history).not.toHaveBeenCalled();
  });

  it('clears through the typed CAS API and keeps the tombstone visible', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    history.mockResolvedValue([]);
    update.mockResolvedValue({ ...snapshot, status: 'cleared', revision: 5, clearedAt: '2026-09-01T00:00:02.000Z' });
    render(<SessionGoalDrawer open onClose={vi.fn()} sessionId="session-a" snapshot={snapshot} />);

    fireEvent.click(screen.getByRole('button', { name: '清除目标' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({
      sessionId: 'session-a', goalId: 'goal-a', revision: 4, action: 'clear',
    }));
    expect(screen.getByText('该目标已清除，历史记录仍保留。')).toBeTruthy();
    confirm.mockRestore();
  });

  it('saves a controlled condition editor with revisioned updates and emits snapshots', async () => {
    history.mockResolvedValue([]);
    update
      .mockResolvedValueOnce({ ...activeSnapshot, status: 'paused', revision: 5, condition: '新条件' })
      .mockResolvedValueOnce({ ...activeSnapshot, status: 'active', revision: 6, condition: '新条件' });
    const onSnapshot = vi.fn();
    render(<SessionGoalDrawer open onClose={vi.fn()} onSnapshot={onSnapshot} sessionId="session-a" snapshot={activeSnapshot} />);

    const input = screen.getByRole('textbox', { name: '目标条件' });
    fireEvent.change(input, { target: { value: '新条件' } });
    fireEvent.click(screen.getByRole('button', { name: '保存目标' }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[0][0]).toMatchObject({ sessionId: 'session-a', goalId: 'goal-a', revision: 4, action: 'pause', payload: { condition: '新条件' } });
    expect(update.mock.calls[1][0]).toMatchObject({ sessionId: 'session-a', goalId: 'goal-a', revision: 5, action: 'resume', payload: { condition: '新条件' } });
    expect(onSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'active', condition: '新条件', revision: 6 }));
  });
});
