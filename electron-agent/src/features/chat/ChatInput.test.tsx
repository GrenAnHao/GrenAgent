import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { onSend, cancelPendingOverlay, getDocument, cleanDocument, toastError, abortEnhancePrompt } = vi.hoisted(() => ({
  onSend: vi.fn(() => Promise.resolve()),
  cancelPendingOverlay: vi.fn(() => Promise.resolve('cancelled' as const)),
  getDocument: vi.fn(() => 'hello'),
  cleanDocument: vi.fn(),
  toastError: vi.fn(),
  abortEnhancePrompt: vi.fn(() => Promise.resolve()),
}));

// App.useApp() 在 <App> 外会退化成静态实例并告警，这里直接给掉，顺带能断言失败 toast。
vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  return { ...actual, App: { ...actual.App, useApp: () => ({ message: { error: toastError } }) } };
});
vi.mock('./input/overlayPrompt', () => ({ cancelPendingOverlay }));
vi.mock('../../lib/pi', () => ({ pi: { abortEnhancePrompt } }));
vi.mock('@lobehub/editor/react', () => ({
  useEditor: () => ({
    getDocument,
    cleanDocument,
    focus: vi.fn(),
    setDocument: vi.fn(),
  }),
}));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStore: () => ({
    useStore: (sel: (s: Record<string, unknown>) => unknown) =>
      sel({ isStreaming: false, messages: [], steering: false, followUp: false }),
  }),
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));
vi.mock('../../store', () => ({ useSessionStore: (sel: (s: { activeSessionPath: null }) => unknown) => sel({ activeSessionPath: null }) }));
vi.mock('../../stores/chatDraftStore', () => ({
  useChatDraftStore: { getState: () => ({ setDraft: vi.fn(), clearDraft: vi.fn(), getDraft: () => '' }) },
}));
vi.mock('./input/editor/MessageEditor', async () => {
  const { useChatInput } = await import('./input/ChatInputContext');
  return {
    MessageEditor: () => {
      const { send } = useChatInput();
      return <button type="button" data-testid="do-send" onClick={() => void send()} />;
    },
  };
});

import { ChatInput } from './ChatInput';
import { fireEvent, screen } from '@testing-library/react';

afterEach(() => {
  cleanup();
  onSend.mockClear();
  cancelPendingOverlay.mockClear();
  toastError.mockClear();
  cleanDocument.mockClear();
  abortEnhancePrompt.mockClear();
  getDocument.mockReturnValue('hello');
});

describe('ChatInput send overlay cancel', () => {
  it('cancels then sends when there is text', async () => {
    render(<ChatInput onSend={onSend} onAbort={vi.fn()} />);
    fireEvent.click(screen.getByTestId('do-send'));
    await vi.waitFor(() => expect(cancelPendingOverlay).toHaveBeenCalledWith('/ws'));
    expect(onSend).toHaveBeenCalled();
  });

  it('sends when overlay cancel is idle', async () => {
    cancelPendingOverlay.mockResolvedValueOnce('idle');
    render(<ChatInput onSend={onSend} onAbort={vi.fn()} />);
    fireEvent.click(screen.getByTestId('do-send'));
    await vi.waitFor(() => expect(cancelPendingOverlay).toHaveBeenCalledWith('/ws'));
    expect(onSend).toHaveBeenCalled();
  });

  it('does not cancel on empty send', async () => {
    getDocument.mockReturnValue('');
    render(<ChatInput onSend={onSend} onAbort={vi.fn()} />);
    fireEvent.click(screen.getByTestId('do-send'));
    await Promise.resolve();
    expect(cancelPendingOverlay).not.toHaveBeenCalled();
    expect(abortEnhancePrompt).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('aborts enhance prompt before overlay cancel and keeps original draft', async () => {
    render(<ChatInput onSend={onSend} onAbort={vi.fn()} />);
    fireEvent.click(screen.getByTestId('do-send'));
    await vi.waitFor(() => expect(abortEnhancePrompt).toHaveBeenCalledWith('/ws'));
    expect(cancelPendingOverlay).toHaveBeenCalledWith('/ws');
    expect(abortEnhancePrompt.mock.invocationCallOrder[0]).toBeLessThan(
      cancelPendingOverlay.mock.invocationCallOrder[0],
    );
    expect(onSend).toHaveBeenCalledWith('hello', undefined, undefined);
  });

  it('does not send when cancel fails', async () => {
    cancelPendingOverlay.mockResolvedValueOnce('failed');
    render(<ChatInput onSend={onSend} onAbort={vi.fn()} />);
    // 切会话载入空草稿会走 setValue('') → cleanDocument，与本次发送无关。
    cleanDocument.mockClear();
    fireEvent.click(screen.getByTestId('do-send'));
    await vi.waitFor(() => expect(cancelPendingOverlay).toHaveBeenCalled());
    expect(onSend).not.toHaveBeenCalled();
    expect(cleanDocument).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(toastError).toHaveBeenCalled());
  });
});
