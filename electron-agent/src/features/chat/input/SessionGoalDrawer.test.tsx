// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalSnapshot } from '../../../stores/goalStore';

const { prompt } = vi.hoisted(() => ({ prompt: vi.fn() }));
vi.mock('../../../lib/pi', () => ({ pi: { prompt } }));
// 二次确认改成了 antd 弹窗；测试里交给 window.confirm，便于按确认 / 取消断言。
vi.mock('../../../components/askConfirm', () => ({
  useAskConfirm: () => async ({ title }: { title: string }) => window.confirm(title),
}));
vi.mock('../../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/repo', store: { getLoadedSessionPath: () => '/repo/s.jsonl' } }),
}));

if (!('ResizeObserver' in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

import { SessionGoalDrawer } from './SessionGoalDrawer';

const snapshot: GoalSnapshot = {
  goalId: 'goal-a',
  sessionId: 'session-a',
  revision: 4,
  condition: '完成并通过测试',
  status: 'blocked',
  roundsStarted: 7,
  maxRounds: 12,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:01.000Z',
  ranMs: 0,
  activation: 'disarmed',
  blockedReason: { code: 'model-reported', message: '等待外部依赖' },
  history: [
    {
      source: 'event',
      kind: 'create',
      goalId: 'goal-a',
      revision: 1,
      at: '2026-09-13T00:00:00.000Z',
      payload: { condition: '完成并通过测试' },
    },
    {
      source: 'round',
      goalId: 'goal-a',
      revision: 2,
      round: 3,
      content: '继续核对工作区证据',
    },
  ],
};

const activeSnapshot: GoalSnapshot = { ...snapshot, status: 'active', activation: 'armed' };

beforeEach(() => {
  prompt.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  prompt.mockReset();
});

describe('SessionGoalDrawer', () => {
  it('renders metadata and snapshot history without AgentData', () => {
    render(<SessionGoalDrawer open onClose={vi.fn()} sessionId="session-a" snapshot={snapshot} />);

    expect(screen.getByText('完成并通过测试', { selector: 'p' })).toBeTruthy();
    expect(screen.getByText('session-a')).toBeTruthy();
    expect(screen.getByText('goal-a')).toBeTruthy();
    expect(screen.getByText('7 / 12')).toBeTruthy();
    expect(screen.getAllByText('等待外部依赖').length).toBeGreaterThan(0);
    expect(screen.getByText(/create/)).toBeTruthy();
    expect(screen.getByText('2026-09-13T00:00:00.000Z')).toBeTruthy();
    expect(screen.getByText('第 3 轮')).toBeTruthy();
    expect(screen.getByText('继续核对工作区证据')).toBeTruthy();
    expect(screen.queryByText('admin.goal.history')).toBeNull();
  });

  it('does not render a closed drawer', () => {
    render(<SessionGoalDrawer open={false} onClose={vi.fn()} sessionId="session-a" snapshot={snapshot} />);
    expect(screen.queryByText('完成并通过测试')).toBeNull();
  });

  it('edits the condition through /goal edit', async () => {
    render(<SessionGoalDrawer open onClose={vi.fn()} sessionId="session-a" snapshot={activeSnapshot} />);

    const input = screen.getByRole('textbox', { name: '目标条件' });
    fireEvent.change(input, { target: { value: '新条件' } });
    fireEvent.click(screen.getByRole('button', { name: '保存目标' }));

    await waitFor(() => expect(prompt).toHaveBeenCalledWith('/repo', '/goal edit 新条件', undefined, undefined, '/repo/s.jsonl'));
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('clears after confirm through /goal clear', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SessionGoalDrawer open onClose={vi.fn()} sessionId="session-a" snapshot={snapshot} />);

    fireEvent.click(screen.getByRole('button', { name: '清除目标' }));
    expect(confirm).toHaveBeenCalledWith('清除当前目标？');
    await waitFor(() => expect(prompt).toHaveBeenCalledWith('/repo', '/goal clear', undefined, undefined, '/repo/s.jsonl'));
    confirm.mockRestore();
  });

  it('sends only one edit prompt when save is clicked twice', async () => {
    prompt.mockImplementation(() => new Promise(() => {}));
    render(<SessionGoalDrawer open onClose={vi.fn()} sessionId="session-a" snapshot={activeSnapshot} />);

    fireEvent.change(screen.getByRole('textbox', { name: '目标条件' }), { target: { value: '新条件' } });
    const save = screen.getByRole('button', { name: '保存目标' });
    act(() => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    expect(prompt).toHaveBeenCalledWith('/repo', '/goal edit 新条件', undefined, undefined, '/repo/s.jsonl');
  });

  it('sends only one clear prompt when clear is clicked twice', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    prompt.mockImplementation(() => new Promise(() => {}));
    render(<SessionGoalDrawer open onClose={vi.fn()} sessionId="session-a" snapshot={snapshot} />);

    const clear = screen.getByRole('button', { name: '清除目标' });
    act(() => {
      clear.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      clear.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    expect(prompt).toHaveBeenCalledWith('/repo', '/goal clear', undefined, undefined, '/repo/s.jsonl');
    confirm.mockRestore();
  });

  it('allows clearing a complete goal', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <SessionGoalDrawer
        open
        onClose={vi.fn()}
        sessionId="session-a"
        snapshot={{ ...snapshot, status: 'complete' }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '清除目标' }));
    await waitFor(() => expect(prompt).toHaveBeenCalledWith('/repo', '/goal clear', undefined, undefined, '/repo/s.jsonl'));
    expect(screen.queryByLabelText('目标条件')).toBeNull();
    confirm.mockRestore();
  });
});
