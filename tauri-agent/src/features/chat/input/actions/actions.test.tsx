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
    getState: vi.fn(() => Promise.resolve({ thinkingLevel: 'off' })),
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

import ThinkingAction from './ThinkingAction';
import CompactAction from './CompactAction';
import NewSessionAction from './NewSessionAction';
import { ChatInputProvider, type ChatInputContextValue } from '../ChatInputContext';

const ctx: ChatInputContextValue = {
  value: '',
  setValue: setValueMock,
  attachments: [],
  addAttachments: vi.fn(),
  removeAttachment: vi.fn(),
  isStreaming: false,
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
  it('ThinkingAction sets thinking level when a menu item is chosen', async () => {
    render(<ThinkingAction />);
    await waitFor(() => {
      expect(piMock.getState).toHaveBeenCalled();
    });
    fireEvent.click(screen.getByText('high'));
    expect(piMock.setThinkingLevel).toHaveBeenCalledWith('/ws', 'high');
  });

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
