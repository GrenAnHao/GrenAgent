import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

// Mock the heavy UI barrels down to plain DOM — tests only assert click → pi call wiring.
vi.mock('@lobehub/ui/base-ui', () => ({
  Select: ({
    options,
    onChange,
    disabled,
  }: {
    options?: { label: string; value: string }[];
    onChange?: (value: string) => void;
    disabled?: boolean;
  }) => (
    <div data-disabled={disabled ? 'true' : 'false'}>
      {options?.map((item) => (
        <button key={item.value} disabled={disabled} onClick={() => onChange?.(item.value)}>
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('@lobehub/ui', () => ({
  ActionIcon: ({ onClick, title }: { onClick?: (e: unknown) => void; title?: string }) => (
    <button title={title} onClick={onClick} />
  ),
  Button: ({ children, onClick }: { children?: unknown; onClick?: (e: unknown) => void }) => (
    <button onClick={onClick}>{children as never}</button>
  ),
  Icon: () => null,
}));

const { piMock, resetMock, setValueMock } = vi.hoisted(() => ({
  piMock: {
    // 推理模型才会有 off 之外的档位（如 high）可选。
    getState: vi.fn(() =>
      Promise.resolve({
        thinkingLevel: 'off',
        model: { id: 'm', provider: 'anthropic', api: 'anthropic-messages', reasoning: true },
      }),
    ),
    setThinkingLevel: vi.fn(() => Promise.resolve()),
    compact: vi.fn(() => Promise.resolve()),
    newSession: vi.fn(() => Promise.resolve()),
  },
  resetMock: vi.fn(),
  setValueMock: vi.fn(),
}));

vi.mock('../../../../lib/pi', () => ({ pi: piMock }));
vi.mock('../../../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({
    workspace: '/ws',
    store: { reset: resetMock },
    workspaceReady: true,
    setWorkspaceReady: vi.fn(),
  }),
}));

import CompactAction from './CompactAction';
import NewSessionAction from './NewSessionAction';
import { ChatInputProvider, type ChatInputContextValue } from '../ChatInputContext';

const ctx: ChatInputContextValue = {
  editor: {} as ChatInputContextValue['editor'],
  empty: true,
  setEmpty: vi.fn(),
  setValue: setValueMock,
  attachments: [],
  addAttachments: vi.fn(),
  removeAttachment: vi.fn(),
  pastedTexts: [],
  addPastedText: vi.fn(),
  removePastedText: vi.fn(),
  isStreaming: false,
  isGenerating: false,
  steering: [],
  followUp: [],
  send: vi.fn(),
  stop: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('chat input actions', () => {
  it('CompactAction triggers compact with workspace', () => {
    render(<CompactAction />);
    fireEvent.click(screen.getByRole('button'));
    expect(piMock.compact).toHaveBeenCalledWith('/ws');
  });

  it('NewSessionAction starts a new session, resets store and clears input', async () => {
    render(
      <ChatInputProvider value={ctx}>
        <NewSessionAction />
      </ChatInputProvider>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(piMock.newSession).toHaveBeenCalledWith('/ws');
    await waitFor(() => {
      expect(resetMock).toHaveBeenCalled();
      expect(setValueMock).toHaveBeenCalledWith('');
    });
  });
});
