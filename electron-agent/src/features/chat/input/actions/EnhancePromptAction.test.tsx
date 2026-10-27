import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalSnapshot } from '../../../stores/goalStore';

const { chatInput, peekComposerModel, getSettings, getState, enhancePrompt, abortEnhancePrompt, session } = vi.hoisted(() => ({
  chatInput: {
    empty: true,
    readDraft: vi.fn(() => ''),
    setValue: vi.fn(),
  },
  peekComposerModel: vi.fn(() => ({ provider: 'openai', id: 'gpt' } as { provider: string; id: string } | null)),
  getSettings: vi.fn(() => Promise.resolve({} as Record<string, string>)),
  getState: vi.fn(() => Promise.resolve({} as Record<string, unknown>)),
  enhancePrompt: vi.fn(() => Promise.resolve({ ok: true, content: '美化' })),
  abortEnhancePrompt: vi.fn(() => Promise.resolve()),
  session: {
    messages: [] as Array<{ kind: string; id: string; text: string; thinking?: string; streaming?: boolean; timestamp?: number }>,
    excluded: new Set<number>(),
  },
}));

vi.mock('@lobehub/ui', () => ({
  ActionIcon: ({
    onClick,
    title,
    disabled,
    'data-testid': testId,
    'aria-busy': ariaBusy,
  }: {
    onClick?: () => void;
    title?: string;
    disabled?: boolean;
    'data-testid'?: string;
    'aria-busy'?: boolean;
  }) => (
    <button
      type="button"
      title={title}
      disabled={disabled}
      data-testid={testId}
      aria-busy={ariaBusy ? 'true' : undefined}
      onClick={onClick}
    />
  ),
  Icon: () => null,
}));

vi.mock('../ChatInputContext', () => ({
  useChatInput: () => chatInput,
}));

vi.mock('./ModelThinkingAction', () => ({
  peekComposerModel,
  default: () => null,
}));

vi.mock('../../../../lib/pi', () => ({
  pi: { getSettings, getState, enhancePrompt, abortEnhancePrompt },
}));

vi.mock('../../../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
  useAgentStore: () => ({ useStore: { getState: () => session } }),
}));

vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  return { ...actual, App: { ...actual.App, useApp: () => ({ message: { warning: vi.fn() } }) } };
});

import EnhancePromptAction from './EnhancePromptAction';
import { useInlineQuestionStore } from '../../../../stores/inlineQuestionStore';
import { useUiPromptStore } from '../../../../stores/uiPromptStore';
import { useGoalStore } from '../../../../stores/goalStore';
import { useEnhancePromptStore } from '../../../../stores/enhancePromptStore';

function makeGoal(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    goalId: 'g1',
    sessionId: 's1',
    revision: 1,
    condition: '完成登录',
    status: 'active',
    roundsStarted: 0,
    maxRounds: 256,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:01.000Z',
    ranMs: 0,
    activation: 'armed',
    ...overrides,
  };
}

async function waitForSettings() {
  await waitFor(() => expect(getSettings).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  chatInput.empty = true;
  chatInput.readDraft.mockReturnValue('');
  chatInput.setValue.mockReset();
  peekComposerModel.mockReturnValue({ provider: 'openai', id: 'gpt' });
  getSettings.mockReset();
  getSettings.mockResolvedValue({});
  getState.mockReset();
  getState.mockResolvedValue({});
  session.messages = [];
  session.excluded = new Set();
  enhancePrompt.mockReset();
  enhancePrompt.mockResolvedValue({ ok: true, content: '美化' });
  abortEnhancePrompt.mockReset();
  abortEnhancePrompt.mockResolvedValue(undefined);
  useInlineQuestionStore.setState({ byWorkspace: {} });
  useUiPromptStore.setState({ byWorkspace: {}, waiting: {} });
  useGoalStore.setState({ bySession: {}, goal: undefined });
  useEnhancePromptStore.setState({ byWorkspace: {} });
});

afterEach(() => {
  cleanup();
});

describe('EnhancePromptAction', () => {
  it('disables the button when the draft is empty', () => {
    chatInput.empty = true;
    render(<EnhancePromptAction />);
    const btn = screen.getByTestId('composer-enhance-prompt');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', '增强提示词');
  });

  it('disables the button when an inline question is pending', () => {
    chatInput.empty = false;
    useInlineQuestionStore.getState().setRequest({
      workspace: '/ws',
      id: 'u1',
      data: {
        kind: 'questions',
        id: 'q1',
        questions: [{ id: 'q1', title: 'T', options: [{ id: 'a', label: '甲' }] }],
      },
      mode: 'live',
    });
    render(<EnhancePromptAction />);
    expect(screen.getByTestId('composer-enhance-prompt')).toBeDisabled();
  });

  it('enables the button when draft has text and composer model is set', () => {
    chatInput.empty = false;
    peekComposerModel.mockReturnValue({ provider: 'openai', id: 'gpt' });
    render(<EnhancePromptAction />);
    expect(screen.getByTestId('composer-enhance-prompt')).not.toBeDisabled();
  });

  it('passes goal text as the fourth argument when project context is on', async () => {
    chatInput.empty = false;
    chatInput.readDraft.mockReturnValue('草稿');
    getSettings.mockResolvedValue({ enhancePromptUseProjectContext: '1' });
    getState.mockResolvedValue({ sessionId: 's1' });
    useGoalStore.getState().setSnapshot('s1', makeGoal());
    render(<EnhancePromptAction />);
    await waitForSettings();
    fireEvent.click(screen.getByTestId('composer-enhance-prompt'));
    await waitFor(() => expect(enhancePrompt).toHaveBeenCalled());
    expect(enhancePrompt.mock.calls[0][0]).toBe('/ws');
    expect(enhancePrompt.mock.calls[0][1]).toBe('草稿');
    expect(enhancePrompt.mock.calls[0][3]).toBe('状态: active\n条件: 完成登录');
    expect(enhancePrompt.mock.calls[0][4]).toBe('');
  });

  it('项目上下文开启时把最近一轮对话交给增强', async () => {
    chatInput.empty = false;
    chatInput.readDraft.mockReturnValue('按上面的方案');
    getSettings.mockResolvedValue({ enhancePromptUseProjectContext: '1' });
    getState.mockResolvedValue({ sessionId: 's1' });
    session.messages = [
      { kind: 'user', id: 'u', text: '修登录', timestamp: 1 },
      { kind: 'assistant', id: 'a', text: '改 auth.ts', thinking: '略', streaming: false, timestamp: 2 },
    ];
    render(<EnhancePromptAction />);
    await waitForSettings();
    fireEvent.click(screen.getByTestId('composer-enhance-prompt'));
    await waitFor(() => expect(enhancePrompt).toHaveBeenCalled());
    expect(enhancePrompt.mock.calls[0][4]).toBe('用户：\n修登录\n\n助手：\n改 auth.ts');
    expect(useEnhancePromptStore.getState().byWorkspace['/ws']?.phase).toBe('正在理解草稿');
  });

  it('passes empty goal text when project context is on but sessionId is missing', async () => {
    chatInput.empty = false;
    chatInput.readDraft.mockReturnValue('草稿');
    getSettings.mockResolvedValue({ enhancePromptUseProjectContext: '1' });
    getState.mockResolvedValue({});
    useGoalStore.getState().setSnapshot('s1', makeGoal());
    render(<EnhancePromptAction />);
    await waitForSettings();
    fireEvent.click(screen.getByTestId('composer-enhance-prompt'));
    await waitFor(() => expect(enhancePrompt).toHaveBeenCalled());
    expect(enhancePrompt.mock.calls[0][3]).toBe('');
  });

  it('invoke 抛错时 fail 槽', async () => {
    chatInput.empty = false;
    chatInput.readDraft.mockReturnValue('草稿');
    enhancePrompt.mockRejectedValueOnce(new Error('IPC 失败'));
    render(<EnhancePromptAction />);
    await waitForSettings();
    fireEvent.click(screen.getByTestId('composer-enhance-prompt'));
    await waitFor(() => {
      expect(useEnhancePromptStore.getState().byWorkspace['/ws']).toMatchObject({
        status: 'error',
        error: 'IPC 失败',
      });
    });
  });

  it('cancelled 且 seq 已变则忽略 clear', async () => {
    chatInput.empty = false;
    chatInput.readDraft.mockReturnValue('草稿');
    let resolveFirst!: (v: unknown) => void;
    enhancePrompt.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));
    enhancePrompt.mockResolvedValueOnce({ ok: true, content: '新' });
    render(<EnhancePromptAction />);
    await waitForSettings();
    fireEvent.click(screen.getByTestId('composer-enhance-prompt'));
    await waitFor(() => expect(enhancePrompt).toHaveBeenCalledTimes(1));
    const seq1 = useEnhancePromptStore.getState().byWorkspace['/ws'].seq;
    useEnhancePromptStore.getState().start('/ws', { source: '新草稿' });
    resolveFirst({ ok: false, content: '', cancelled: true });
    await act(async () => { await Promise.resolve(); });
    const slot = useEnhancePromptStore.getState().byWorkspace['/ws'];
    expect(slot.seq).toBeGreaterThan(seq1);
    expect(slot.status).toBe('streaming');
  });

  it('主进程久不返回时看门狗置错并 abort，不再停在生成中', async () => {
    vi.useFakeTimers();
    try {
      chatInput.empty = false;
      chatInput.readDraft.mockReturnValue('草稿');
      enhancePrompt.mockImplementation(() => new Promise(() => {}));
      render(<EnhancePromptAction />);
      await act(async () => { await Promise.resolve(); });
      fireEvent.click(screen.getByTestId('composer-enhance-prompt'));
      await act(async () => { await Promise.resolve(); });
      expect(enhancePrompt).toHaveBeenCalled();
      expect(useEnhancePromptStore.getState().byWorkspace['/ws']?.status).toBe('streaming');
      await act(async () => { await vi.advanceTimersByTimeAsync(75_000); });
      expect(useEnhancePromptStore.getState().byWorkspace['/ws']).toMatchObject({
        status: 'error',
        error: '增强超时，请重试',
      });
      expect(abortEnhancePrompt).toHaveBeenCalledWith('/ws');
    } finally {
      vi.useRealTimers();
    }
  });

  it('实验开关开时看门狗用 105s 窗口', async () => {
    vi.useFakeTimers();
    try {
      chatInput.empty = false;
      chatInput.readDraft.mockReturnValue('草稿');
      getSettings.mockResolvedValue({ enhancePromptUseProjectContext: '1' });
      enhancePrompt.mockImplementation(() => new Promise(() => {}));
      render(<EnhancePromptAction />);
      await act(async () => { await Promise.resolve(); });
      fireEvent.click(screen.getByTestId('composer-enhance-prompt'));
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(75_000); });
      expect(useEnhancePromptStore.getState().byWorkspace['/ws']?.status).toBe('streaming');
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(useEnhancePromptStore.getState().byWorkspace['/ws']).toMatchObject({ status: 'error' });
    } finally {
      vi.useRealTimers();
    }
  });
});
