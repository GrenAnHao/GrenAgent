// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useGoalStore } from '../../../../stores/goalStore';

const { addPastedText, send } = vi.hoisted(() => ({
  addPastedText: vi.fn(),
  send: vi.fn(),
}));

vi.mock('../../../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/repo' }),
}));
vi.mock('../ChatInputContext', () => ({
  useChatInput: () => ({
    editor: {
      cleanDocument: vi.fn(),
      focus: vi.fn(),
      isEmpty: true,
    },
    send,
    addAttachments: vi.fn(),
    addPastedText,
    setEmpty: vi.fn(),
    attachments: [],
    pastedTexts: [],
    isGenerating: false,
  }),
}));
vi.mock('../workspace/WorkspaceBar', () => ({
  WorkspaceBar: ({ onReferencePastedText }: { onReferencePastedText?: (item: unknown) => void }) => (
    <button
      type="button"
      onClick={() =>
        onReferencePastedText?.({
          id: 'project-context-1',
          text: 'CodeGraph symbol details',
          lines: 1,
          chars: 24,
          source: 'project:///repo/codegraph',
          referenceOnly: false,
        })
      }
    >
      引用当前内容
    </button>
  ),
}));
vi.mock('@lobehub/editor/react', () => ({ Editor: () => null }));
vi.mock('../ActionBar', () => ({ ActionBar: () => null }));
vi.mock('../SendArea', () => ({ SendArea: () => null }));
vi.mock('../SteerQueue', () => ({ SteerQueue: () => null }));
vi.mock('../GoalPill', () => ({
  GoalPill: ({ onOpenDetails }: { onOpenDetails?: (snapshot: { sessionId: string }) => void }) => (
    <button
      type="button"
      onClick={() => onOpenDetails?.({
        sessionId: 'session-a',
        goalId: 'goal-a',
        workspace: '/repo',
        revision: 1,
        condition: '完成测试',
        status: 'active',
        roundsUsed: 1,
        maxRounds: 10,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:01.000Z',
      } as never)}
    >
      查看目标详情
    </button>
  ),
}));
vi.mock('../SessionGoalDrawer', () => ({
  SessionGoalDrawer: ({ open, snapshot }: { open: boolean; snapshot?: { condition?: string } }) =>
    open ? <div data-testid="session-goal-drawer">{snapshot?.condition}</div> : null,
}));
vi.mock('../PromptRequestCard', () => ({ PromptRequestCard: () => null }));
vi.mock('../ContextUsageTag', () => ({ ContextUsageTag: () => null }));
vi.mock('./InputChips', () => ({ InputChips: () => null }));
vi.mock('./ChatTag/ReactChatTagPlugin', () => ({ default: {} }));
vi.mock('./SlashBoxMenu', () => ({ createBoxMenu: () => () => null }));
vi.mock('./useCommandPaste', () => ({ useCommandPaste: () => ({ tryCommandPaste: vi.fn() }) }));
vi.mock('./useUrlPaste', () => ({ useUrlPaste: () => ({ tryUrlPaste: vi.fn() }) }));
vi.mock('./usePasteCapture', () => ({ usePasteCapture: () => undefined }));
vi.mock('./useFileMention', () => ({ useFileMention: () => ({ mentionItems: [], onSelect: vi.fn() }) }));
vi.mock('./useSlashOptions', () => ({ useSlashOptions: () => ({ slashItems: [], onSelect: vi.fn() }) }));
vi.mock('./useTauriFileDrop', () => ({ useTauriFileDrop: () => ({ dragOver: false, dragKind: null }) }));

import { MessageEditor } from './MessageEditor';

afterEach(() => {
  cleanup();
  useGoalStore.setState({ bySession: {}, goal: undefined });
  addPastedText.mockClear();
  send.mockClear();
});

describe('MessageEditor project context citations', () => {
  it('adds project context content without sending the message', () => {
    render(<MessageEditor leftActions={[]} rightActions={[]} />);

    fireEvent.click(screen.getByRole('button', { name: '引用当前内容' }));

    expect(addPastedText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('CodeGraph'),
        source: expect.stringContaining('project://'),
        referenceOnly: false,
      }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('opens the Goal drawer in the input surface for the selected session', () => {
    useGoalStore.getState().setSnapshot('session-a', {
      goalId: 'goal-a',
      sessionId: 'session-a',
      workspace: '/repo',
      revision: 1,
      condition: '完成测试',
      status: 'active',
      roundsUsed: 1,
      maxRounds: 10,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:01.000Z',
    });
    render(<MessageEditor leftActions={[]} rightActions={[]} />);

    fireEvent.click(screen.getByRole('button', { name: '查看目标详情' }));

    expect(screen.getByTestId('session-goal-drawer')).toHaveTextContent('完成测试');
  });
});
