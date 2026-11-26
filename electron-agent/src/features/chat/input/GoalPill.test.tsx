// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGoalStore, type GoalSnapshot } from '../../../stores/goalStore';

const { getGoal, goalControl } = vi.hoisted(() => ({
  getGoal: vi.fn(),
  goalControl: vi.fn(),
}));
let activeSessionPath: string | null = '/sessions/a.jsonl';

vi.mock('../../../lib/pi', () => ({ pi: { getGoal, goalControl } }));
vi.mock('../../../store/session', () => ({
  useSessionStore: Object.assign(
    (selector: (state: { activeSessionPath: string | null }) => unknown) => selector({ activeSessionPath }),
    { getState: () => ({ activeSessionPath }) },
  ),
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
  useGoalStore.setState({ bySession: {}, watermarks: {}, mutationFences: {}, sessionIdByPath: {}, goal: undefined });
  activeSessionPath = '/sessions/a.jsonl';
  getGoal.mockResolvedValue(null);
  goalControl.mockImplementation(async (_workspace, _path, request) => ({
    ...request, sessionId: 'session-a', ownerEpoch: 'epoch-a', outcome: 'committed',
    committedRevision: request.expectedRevision + 1,
    snapshot: { ...makeSnapshot(), condition: request.condition ?? '写完测试', revision: request.expectedRevision + 1,
      conditionRevision: request.expectedConditionRevision + (request.action === 'edit' ? 1 : 0) },
  }));
});

afterEach(() => {
  cleanup();
  getGoal.mockReset();
  goalControl.mockReset();
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
    expect(screen.getByRole('button', { name: '保存目标' }).getAttribute('tabindex')).toBe('-1');

    fireEvent.change(input, { target: { value: '新条件' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(goalControl).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: '目标条件' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '编辑目标' }));
    fireEvent.change(screen.getByRole('textbox', { name: '目标条件' }), { target: { value: '新条件' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: '目标条件' }), { key: 'Enter' });

    await waitFor(() => expect(goalControl).toHaveBeenCalledWith('/repo', '/sessions/a.jsonl', expect.objectContaining({ action: 'edit', condition: '新条件', expectedConditionRevision: 1 })));
  });

  it('clears only after confirm and ignores a second click while busy', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    let resolveControl: (value: unknown) => void = () => undefined;
    goalControl.mockImplementation(() => new Promise((resolve) => {
      resolveControl = (value) => resolve(value);
    }));
    await renderGoal();

    fireEvent.click(screen.getByRole('button', { name: '清除目标' }));
    await waitFor(() => expect(goalControl).toHaveBeenCalledTimes(1));
    // 确认弹窗开着时遮罩挡住点击；这里测的是清除进行中再点一次。
    fireEvent.click(screen.getByRole('button', { name: '清除目标' }));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith('清除当前目标？');
    expect(goalControl).toHaveBeenCalledTimes(1);
    expect(goalControl).toHaveBeenCalledWith('/repo', '/sessions/a.jsonl', expect.objectContaining({ action: 'clear' }));
    resolveControl({});
    confirm.mockRestore();
  });

  it('does not clear when confirm is dismissed', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderGoal();

    fireEvent.click(screen.getByRole('button', { name: '清除目标' }));

    expect(confirm).toHaveBeenCalledWith('清除当前目标？');
    expect(goalControl).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('pauses an armed goal and resumes a paused goal', async () => {
    await renderGoal();
    fireEvent.click(screen.getByRole('button', { name: '暂停目标' }));
    await waitFor(() => expect(goalControl).toHaveBeenCalledWith('/repo', '/sessions/a.jsonl', expect.objectContaining({ action: 'pause' })));
    await waitFor(() => expect(getGoal).toHaveBeenCalledWith('/repo', '/sessions/a.jsonl'));

    cleanup();
    goalControl.mockClear();
    await renderGoal({ status: 'paused', activation: 'disarmed', revision: 3 });
    fireEvent.click(screen.getByRole('button', { name: '恢复目标' }));
    await waitFor(() => expect(goalControl).toHaveBeenCalledWith('/repo', '/sessions/a.jsonl', expect.objectContaining({ action: 'resume' })));
  });

  it('never shows the round budget on the bar', async () => {
    await renderGoal({ roundsStarted: 12, maxRounds: 256 });
    expect(screen.queryByText(/\/256/)).toBeNull();
  });

  it('waits for the matching committed receipt despite same-text external updates and stale pulls', async () => {
    let resolveReceipt: (receipt: unknown) => void = () => undefined;
    goalControl.mockImplementation(() => new Promise((resolve) => { resolveReceipt = resolve; }));
    await renderGoal({ runStartedAt: undefined, conditionRevision: 1 });
    fireEvent.click(screen.getByRole('button', { name: '编辑目标' }));
    const input = screen.getByRole('textbox', { name: '目标条件' });
    fireEvent.change(input, { target: { value: '新条件' } });
    fireEvent.click(screen.getByRole('button', { name: '保存目标' }));
    await waitFor(() => expect(goalControl).toHaveBeenCalledTimes(1));
    act(() => useGoalStore.getState().setSnapshot('session-a', makeSnapshot({ condition: '新条件', revision: 3, conditionRevision: 2 })));
    expect(screen.getByRole('textbox', { name: '目标条件' })).toBe(input);
    const request = goalControl.mock.calls[0][2];
    await act(async () => resolveReceipt({ ...request, sessionId: 'session-a', goalId: 'goal-a', ownerEpoch: 'epoch-a',
      action: 'edit', outcome: 'committed', committedRevision: 3, snapshot: { ...makeSnapshot({ condition: '新条件', revision: 3, conditionRevision: 2 }) },
      operationId: 'foreign-operation' }));
    expect(screen.getByRole('textbox', { name: '目标条件' })).toBe(input);
    expect(screen.getByRole('alert').textContent).toContain('不匹配');
  });

  it('retries a lost edit acknowledgement with the original operationId and preserves draft', async () => {
    goalControl.mockRejectedValueOnce(new Error('transport closed'));
    await renderGoal({ runStartedAt: undefined });
    fireEvent.click(screen.getByRole('button', { name: '编辑目标' }));
    fireEvent.change(screen.getByRole('textbox', { name: '目标条件' }), { target: { value: '离线草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '保存目标' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('同一操作标识'));
    const originalId = goalControl.mock.calls[0][2].operationId;
    expect((screen.getByRole('textbox', { name: '目标条件' }) as HTMLInputElement).value).toBe('离线草稿');
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '目标条件' }));
    fireEvent.click(screen.getByRole('button', { name: '保存目标' }));
    await waitFor(() => expect(goalControl).toHaveBeenCalledTimes(2));
    expect(goalControl.mock.calls[1][2].operationId).toBe(originalId);
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '目标条件' })).toBeNull());
  });

  it('keeps an in-flight edit bound to its original session when the foreground changes', async () => {
    let resolveReceipt: (value: unknown) => void = () => undefined;
    goalControl.mockImplementation(() => new Promise((resolve) => { resolveReceipt = resolve; }));
    useGoalStore.getState().bindSessionPath('/sessions/a.jsonl', 'session-a');
    useGoalStore.getState().setSnapshot('session-a', makeSnapshot({ runStartedAt: undefined }));
    useGoalStore.getState().bindSessionPath('/sessions/b.jsonl', 'session-b');
    useGoalStore.getState().setSnapshot('session-b', { ...makeSnapshot({ runStartedAt: undefined }), goalId: 'goal-b', sessionId: 'session-b', condition: '乙会话条件' });
    const view = render(<GoalPill />);
    fireEvent.click(await screen.findByRole('button', { name: '编辑目标' }));
    fireEvent.change(screen.getByRole('textbox', { name: '目标条件' }), { target: { value: '甲会话草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '保存目标' }));
    await waitFor(() => expect(goalControl).toHaveBeenCalledTimes(1));
    const request = goalControl.mock.calls[0][2];
    expect(goalControl.mock.calls[0][1]).toBe('/sessions/a.jsonl');
    activeSessionPath = '/sessions/b.jsonl';
    view.rerender(<GoalPill onOpenDetails={vi.fn()} />);
    expect(await screen.findByText('· 乙会话条件')).toBeTruthy();
    await act(async () => resolveReceipt({ ...request, ownerEpoch: 'epoch-a', sessionId: 'session-a', action: 'edit',
      outcome: 'committed', committedRevision: 3,
      snapshot: { ...makeSnapshot({ condition: '甲会话草稿', revision: 3, conditionRevision: 2 }) } }));
    expect(screen.getByText('· 乙会话条件')).toBeTruthy();
    expect(screen.queryByText('· 甲会话草稿')).toBeNull();
  });

  it('requires an explicit decision after a real condition conflict', async () => {
    await renderGoal({ runStartedAt: undefined, conditionRevision: 1 });
    fireEvent.click(screen.getByRole('button', { name: '编辑目标' }));
    const input = screen.getByRole('textbox', { name: '目标条件' });
    fireEvent.change(input, { target: { value: '我的草稿' } });
    act(() => useGoalStore.getState().setSnapshot('session-a', makeSnapshot({ condition: '远端条件', conditionRevision: 2, revision: 3 })));
    expect(screen.getByRole('alert').textContent).toContain('其他操作修改');
    expect((input as HTMLInputElement).value).toBe('我的草稿');
    fireEvent.click(screen.getByRole('button', { name: '基于最新版提交' }));
    expect((input as HTMLInputElement).value).toBe('我的草稿');
    fireEvent.click(screen.getByRole('button', { name: '保存目标' }));
    await waitFor(() => expect(goalControl).toHaveBeenCalledWith('/repo', '/sessions/a.jsonl', expect.objectContaining({ condition: '我的草稿', expectedRevision: 3, expectedConditionRevision: 2 })));
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
