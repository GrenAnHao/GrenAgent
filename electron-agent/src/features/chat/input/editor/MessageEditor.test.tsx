// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGoalStore, type GoalSnapshot } from '../../../../stores/goalStore';

const { addPastedText, send, getState, prompt } = vi.hoisted(() => ({
  addPastedText: vi.fn(),
  send: vi.fn(),
  getState: vi.fn(),
  prompt: vi.fn(),
}));

const chatInput = vi.hoisted(() => ({
  steering: [] as string[],
  followUp: [] as string[],
}));

vi.mock('../../../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/repo' }),
  useAgentStore: () => ({
    useStore: (sel: (s: { messages: unknown[] }) => unknown) => sel({ messages: [] }),
  }),
}));
vi.mock('../../../../lib/pi', () => ({ pi: { getState, prompt } }));
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
    steering: chatInput.steering,
    followUp: chatInput.followUp,
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
vi.mock('../SessionGoalDrawer', () => ({
  SessionGoalDrawer: ({ open, snapshot }: { open: boolean; snapshot?: { condition?: string } }) =>
    open ? <div data-testid="session-goal-drawer">{snapshot?.condition}</div> : null,
}));
vi.mock('../ComposerPromptOverlay', () => ({ ComposerPromptOverlay: () => null }));
vi.mock('../EnhancePromptOverlay', () => ({ EnhancePromptOverlay: () => null }));
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
import { useUiPromptStore } from '../../../../stores/uiPromptStore';

if (!('ResizeObserver' in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

const snapshot: GoalSnapshot = {
  goalId: 'goal-a',
  sessionId: 'session-a',
  revision: 1,
  condition: '完成测试',
  status: 'active',
  roundsStarted: 1,
  maxRounds: 10,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:01.000Z',
  ranMs: 0,
  activation: 'armed',
};

beforeEach(() => {
  getState.mockResolvedValue({ sessionId: 'session-a' });
  prompt.mockResolvedValue(undefined);
  chatInput.steering = [];
  chatInput.followUp = [];
});

afterEach(() => {
  cleanup();
  useGoalStore.setState({ bySession: {}, goal: undefined });
  useUiPromptStore.setState({ byWorkspace: {} });
  addPastedText.mockClear();
  send.mockClear();
  getState.mockReset();
  prompt.mockReset();
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

  it('opens the Goal drawer in the input surface for the selected session', async () => {
    useGoalStore.getState().setSnapshot('session-a', snapshot);
    render(<MessageEditor leftActions={[]} rightActions={[]} />);

    fireEvent.click(await screen.findByRole('button', { name: '展开目标详情' }));

    expect(screen.getByTestId('session-goal-drawer')).toHaveTextContent('完成测试');
  });

  it('keeps the goal pill in the dock, outside the composer surface', async () => {
    useGoalStore.getState().setSnapshot('session-a', snapshot);
    render(<MessageEditor leftActions={[]} rightActions={[]} />);

    const surface = await screen.findByTestId('composer-surface');
    const pill = await screen.findByTestId('goal-pill');
    expect(surface.contains(pill)).toBe(false);
    expect(screen.getByTestId('composer-dock').contains(pill)).toBe(true);
  });

  it('keeps the steer queue in the dock, outside the composer surface', async () => {
    chatInput.steering = ['先改测试'];
    render(<MessageEditor leftActions={[]} rightActions={[]} />);

    const surface = await screen.findByTestId('composer-surface');
    const queue = await screen.findByTestId('steer-queue');
    expect(surface.contains(queue)).toBe(false);
    expect(screen.getByTestId('composer-dock').contains(queue)).toBe(true);
  });

  it('keeps the approval card in the editor flow, not the overlay', () => {
    useUiPromptStore.getState().setRequest({
      workspace: '/repo',
      request: { id: 'u1', method: 'select', title: '危险命令：rm -rf ./tmp', options: ['允许', '拒绝'] },
    });
    render(<MessageEditor leftActions={[]} rightActions={[]} />);

    const approval = screen.getByTestId('prompt-request-approval');
    const surface = screen.getByTestId('composer-surface');
    expect(surface.contains(approval)).toBe(false);
    expect(screen.getByTestId('composer-dock').parentElement?.contains(approval)).toBe(true);
    expect(screen.queryByTestId('composer-prompt-overlay')).toBeNull();
  });
});
