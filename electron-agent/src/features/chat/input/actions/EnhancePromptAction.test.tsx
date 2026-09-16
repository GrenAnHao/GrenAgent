import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalSnapshot } from '../../../stores/goalStore';

const { chatInput, peekComposerModel, getSettings, getState, enhancePrompt } = vi.hoisted(() => ({
  chatInput: {
    empty: true,
    readDraft: vi.fn(() => ''),
    setValue: vi.fn(),
  },
  peekComposerModel: vi.fn(() => ({ provider: 'openai', id: 'gpt' } as { provider: string; id: string } | null)),
  getSettings: vi.fn(() => Promise.resolve({} as Record<string, string>)),
  getState: vi.fn(() => Promise.resolve({} as Record<string, unknown>)),
  enhancePrompt: vi.fn(() => Promise.resolve({ ok: true, content: '美化' })),
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
  pi: { getSettings, getState, enhancePrompt },
}));

vi.mock('../../../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
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
  enhancePrompt.mockReset();
  enhancePrompt.mockResolvedValue({ ok: true, content: '美化' });
  useInlineQuestionStore.setState({ byWorkspace: {} });
  useUiPromptStore.setState({ byWorkspace: {} });
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
});
