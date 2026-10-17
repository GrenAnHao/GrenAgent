// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGoalStore, type GoalSnapshot } from '../../../stores/goalStore';

const { getGoal, prompt } = vi.hoisted(() => ({
  getGoal: vi.fn(),
  prompt: vi.fn(),
}));
let activeSessionPath: string | null = '/sessions/a.jsonl';

vi.mock('../../../lib/pi', () => ({ pi: { getGoal, prompt } }));
vi.mock('../../../store/session', () => ({
  useSessionStore: (selector: (state: { activeSessionPath: string | null }) => unknown) =>
    selector({ activeSessionPath }),
}));
// 二次确认改成了 antd 弹窗；测试里交给 window.confirm，便于按确认 / 取消断言。
vi.mock('../../../components/askConfirm', () => ({
  useAskConfirm: () => async ({ title }: { title: string }) => window.confirm(title),
}));
vi.mock('../../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/repo', store: { getLoadedSessionPath: () => '/repo/s.jsonl' } }),
}));

import { GoalPill } from './GoalPill';
import { applyGoalStatus } from '../../extensionUi/goalStatus';

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
  revision: 2,
  condition: '写完测试',
  status: 'active',
  roundsStarted: 3,
  maxRounds: 256,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:01.000Z',
  ranMs: 0,
  runStartedAt: '2026-09-01T00:00:00.000Z',
  activation: 'armed',
  ...overrides,
});

const envelope = (sessionId: string, snapshot: Partial<GoalSnapshot> | null) => ({
  schemaVersion: 1,
  sessionId,
  snapshot: snapshot === null ? null : { ...makeSnapshot(), ...snapshot },
  history: [],
});

async function renderGoal(overrides: Partial<GoalSnapshot> = {}, props: { onOpenDetails?: (snapshot: GoalSnapshot) => void } = {}) {
  useGoalStore.getState().bindSessionPath('/sessions/a.jsonl', 'session-a');
  useGoalStore.getState().setSnapshot('session-a', makeSnapshot(overrides));
  render(<GoalPill {...props} />);
  return screen.findByTestId('goal-pill');
}

function lampStyle(): string {
  return screen.getByTestId('goal-lamp').getAttribute('style') ?? '';
}

beforeEach(() => {
  useGoalStore.setState({ bySession: {}, sessionIdByPath: {}, goal: undefined });
  activeSessionPath = '/sessions/a.jsonl';
  getGoal.mockResolvedValue(null);
  prompt.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  getGoal.mockReset();
  prompt.mockReset();
});

describe('GoalPill', () => {
  it('renders armed active status, glowing lamp, and action labels', async () => {
    await renderGoal();

    expect(screen.getByText('执行中的目标')).toBeTruthy();
    expect(screen.getByText('· 写完测试')).toBeTruthy();
    expect(lampStyle()).toContain('#3dd68c');
    expect(lampStyle()).toMatch(/box-shadow/i);
    expect(screen.getByRole('button', { name: '暂停目标' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '编辑目标' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '清除目标' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '展开目标详情' })).toBeTruthy();
    expect(screen.queryByText(/\/256/)).toBeNull();
  });

  it('renders disarmed active as idle with a gray lamp and resume', async () => {
    await renderGoal({ activation: 'disarmed' });

    expect(screen.getByText('未运行的目标')).toBeTruthy();
    expect(lampStyle()).toContain('#8b919c');
    expect(lampStyle()).toMatch(/box-shadow:\s*none/i);
    expect(screen.getByRole('button', { name: '恢复目标' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '暂停目标' })).toBeNull();
  });

  it('renders paused with an amber lamp and resume', async () => {
    await renderGoal({ status: 'paused', activation: 'disarmed' });

    expect(screen.getByText('已暂停的目标')).toBeTruthy();
    expect(lampStyle()).toContain('#f5a524');
    expect(screen.getByRole('button', { name: '恢复目标' })).toBeTruthy();
  });

  it('renders blocked with a red lamp and row title from the reason', async () => {
    const pill = await renderGoal({
      status: 'blocked',
      activation: 'disarmed',
      blockedReason: { code: 'model-reported', message: '缺密钥' },
    });

    expect(screen.getByText('受阻的目标')).toBeTruthy();
    expect(lampStyle()).toContain('#f53f3f');
    expect(pill.getAttribute('title')).toBe('缺密钥');
    expect(screen.getByRole('button', { name: '恢复目标' })).toBeTruthy();
  });

  it('renders complete without pause or edit, green lamp without glow', async () => {
    await renderGoal({ status: 'complete', activation: 'disarmed' });

    expect(screen.getByText('已完成的目标')).toBeTruthy();
    expect(lampStyle()).toContain('#3dd68c');
    expect(lampStyle()).toMatch(/box-shadow:\s*none/i);
    expect(screen.queryByRole('button', { name: '暂停目标' })).toBeNull();
    expect(screen.queryByRole('button', { name: '恢复目标' })).toBeNull();
    expect(screen.queryByRole('button', { name: '编辑目标' })).toBeNull();
    expect(screen.getByRole('button', { name: '清除目标' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '展开目标详情' })).toBeTruthy();
  });

  it('pulls the goal by the active session path on mount (first open after restart)', async () => {
    getGoal.mockResolvedValue(envelope('session-a', { activation: 'disarmed' }));
    render(<GoalPill />);

    expect(await screen.findByTestId('goal-pill')).toBeTruthy();
    expect(getGoal).toHaveBeenCalledWith('/repo', '/sessions/a.jsonl');
    expect(screen.getByText('未运行的目标')).toBeTruthy();
  });

  it('shows a goal pushed for the active path while the turn is running, without switching sessions', async () => {
    render(<GoalPill />);
    await waitFor(() => expect(getGoal).toHaveBeenCalled());
    expect(screen.queryByTestId('goal-pill')).toBeNull();

    // 推送信封带会话路径（大小写、分隔符可以不同），sessionId 由它绑定。
    act(() => {
      applyGoalStatus(JSON.stringify(envelope('session-a', {})), 'session-a', '\\SESSIONS\\A.jsonl');
    });
    expect(await screen.findByText('执行中的目标')).toBeTruthy();
  });

  it('never shows a goal pushed for another session', async () => {
    render(<GoalPill />);
    await waitFor(() => expect(getGoal).toHaveBeenCalled());
    act(() => {
      applyGoalStatus(JSON.stringify(envelope('session-b', { condition: '别的会话' })), 'session-b', '/sessions/b.jsonl');
    });
    expect(screen.queryByTestId('goal-pill')).toBeNull();
    expect(screen.queryByText('· 别的会话')).toBeNull();
  });

  it('does not render a pill when the pulled session has no goal', async () => {
    getGoal.mockResolvedValue(envelope('session-a', null));
    render(<GoalPill />);
    await waitFor(() => expect(useGoalStore.getState().sessionIdByPath['/sessions/a.jsonl']).toBe('session-a'));
    expect(screen.queryByTestId('goal-pill')).toBeNull();
  });

  it('edits the condition with Enter and ignores Escape', async () => {
    await renderGoal();

    fireEvent.click(screen.getByRole('button', { name: '编辑目标' }));
    const input = screen.getByRole('textbox', { name: '目标条件' });
    expect((input as HTMLInputElement).value).toBe('写完测试');

    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: '保存目标' })).toBeDisabled();

    fireEvent.change(input, { target: { value: '新条件' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(prompt).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: '目标条件' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '编辑目标' }));
    fireEvent.change(screen.getByRole('textbox', { name: '目标条件' }), { target: { value: '新条件' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: '目标条件' }), { key: 'Enter' });

    await waitFor(() => expect(prompt).toHaveBeenCalledWith('/repo', '/goal edit 新条件', undefined, undefined, '/repo/s.jsonl'));
  });

  it('clears only after confirm and ignores a second click while busy', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    let resolvePrompt: () => void = () => undefined;
    prompt.mockImplementation(() => new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    }));
    await renderGoal();

    fireEvent.click(screen.getByRole('button', { name: '清除目标' }));
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    // 确认弹窗开着时遮罩挡住点击；这里测的是清除进行中再点一次。
    fireEvent.click(screen.getByRole('button', { name: '清除目标' }));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith('清除当前目标？');
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith('/repo', '/goal clear', undefined, undefined, '/repo/s.jsonl');
    resolvePrompt();
    confirm.mockRestore();
  });

  it('does not clear when confirm is dismissed', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderGoal();

    fireEvent.click(screen.getByRole('button', { name: '清除目标' }));

    expect(confirm).toHaveBeenCalledWith('清除当前目标？');
    expect(prompt).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('pauses an armed goal and resumes a paused goal', async () => {
    await renderGoal();
    fireEvent.click(screen.getByRole('button', { name: '暂停目标' }));
    await waitFor(() => expect(prompt).toHaveBeenCalledWith('/repo', '/goal pause', undefined, undefined, '/repo/s.jsonl'));
    // 命令返回后按那份会话的路径再补拉一次。
    await waitFor(() => expect(getGoal).toHaveBeenCalledWith('/repo', '/repo/s.jsonl'));

    cleanup();
    prompt.mockClear();
    await renderGoal({ status: 'paused', activation: 'disarmed', revision: 3 });
    fireEvent.click(screen.getByRole('button', { name: '恢复目标' }));
    await waitFor(() => expect(prompt).toHaveBeenCalledWith('/repo', '/goal resume', undefined, undefined, '/repo/s.jsonl'));
  });

  it('never shows the round budget on the bar', async () => {
    await renderGoal({ roundsStarted: 12, maxRounds: 256 });
    expect(screen.queryByText(/\/256/)).toBeNull();
  });

  it('keeps the elapsed label after pause instead of resetting to 1s', async () => {
    await renderGoal({
      status: 'paused',
      activation: 'disarmed',
      ranMs: 125_000,
      runStartedAt: undefined,
    });
    expect(screen.getByText('· 2m')).toBeTruthy();
  });
});
