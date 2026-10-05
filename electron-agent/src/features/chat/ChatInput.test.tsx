import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { onSend, cancelPendingOverlay, getDocument, cleanDocument, setDocument, toastError, abortEnhancePrompt, chatState } = vi.hoisted(() => ({
  onSend: vi.fn(() => Promise.resolve()),
  cancelPendingOverlay: vi.fn(() => Promise.resolve('cancelled' as const)),
  getDocument: vi.fn(() => 'hello'),
  cleanDocument: vi.fn(),
  setDocument: vi.fn(),
  toastError: vi.fn(),
  abortEnhancePrompt: vi.fn(() => Promise.resolve()),
  chatState: { isStreaming: false, messages: [] as unknown[], steering: [] as string[], followUp: [] as string[], composerQueue: [] as unknown[] },
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
    setDocument,
    focus: vi.fn(),
  }),
}));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStore: () => ({
    useStore: Object.assign((sel: (s: typeof chatState) => unknown) => sel(chatState), {
      getState: () => chatState,
      setState: (partial: Partial<typeof chatState> | ((s: typeof chatState) => Partial<typeof chatState>)) => {
        const patch = typeof partial === 'function' ? partial(chatState) : partial;
        Object.assign(chatState, patch);
      },
    }),
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
      const { send, pastedTexts } = useChatInput();
      return (
        <>
          <button type="button" data-testid="do-send" onClick={() => void send()} />
          <button type="button" data-testid="do-interrupt" onClick={() => void send({ interrupt: true })} />
          <span data-testid="pasted-count">{pastedTexts.length}</span>
          {pastedTexts[0] ? <span data-testid="pasted-source">{pastedTexts[0].label || pastedTexts[0].source}</span> : null}
        </>
      );
    },
  };
});

import { ChatInput } from './ChatInput';
import { fireEvent, screen } from '@testing-library/react';
import { offerBrowserElementToChat } from '../dock/browser/browserElementPicker';

afterEach(() => {
  cleanup();
  onSend.mockClear();
  cancelPendingOverlay.mockClear();
  toastError.mockClear();
  cleanDocument.mockClear();
  setDocument.mockClear();
  abortEnhancePrompt.mockClear();
  getDocument.mockReturnValue('hello');
  chatState.isStreaming = false;
  chatState.messages = [];
  chatState.steering = [];
  chatState.followUp = [];
  chatState.composerQueue = [];
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

  it('empty send with queued follow-up after stop flushes follow-up', async () => {
    getDocument.mockReturnValue('');
    chatState.followUp = ['改用 chrome 跑自动化'];
    render(<ChatInput onSend={onSend} onAbort={vi.fn()} />);
    fireEvent.click(screen.getByTestId('do-send'));
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledWith('', undefined, 'followUp'));
    expect(cancelPendingOverlay).toHaveBeenCalledWith('/ws');
  });

  it('运行中发送先挂成跟进，不打断当前回复', async () => {
    chatState.isStreaming = true;
    chatState.messages = [{ kind: 'tool', id: 't1', toolCallId: 'c1', toolName: 'bash', args: {}, result: {}, status: 'running' }];
    const onAbort = vi.fn();
    render(<ChatInput onSend={onSend} onAbort={onAbort} />);
    fireEvent.click(screen.getByTestId('do-send'));
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledWith('hello', undefined, 'followUp'));
    expect(onAbort).not.toHaveBeenCalled();
  });

  it('跟进挂着且输入为空时，回车改为引导，不打断会话', async () => {
    getDocument.mockReturnValue('');
    chatState.isStreaming = true;
    chatState.composerQueue = [{ id: 'cq-1', text: '怎么停滞了' }];
    const onAbort = vi.fn();
    render(<ChatInput onSend={onSend} onAbort={onAbort} />);
    fireEvent.click(screen.getByTestId('do-send'));
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledWith('怎么停滞了', undefined, 'steer'));
    expect(onAbort).not.toHaveBeenCalled();
    expect(chatState.composerQueue).toEqual([]);
  });

  it('跟进挂着且输入为空时，Ctrl+Enter 先停掉会话再发出', async () => {
    getDocument.mockReturnValue('');
    chatState.isStreaming = true;
    chatState.composerQueue = [{ id: 'cq-1', text: '怎么停滞了' }];
    const onAbort = vi.fn(async () => {
      chatState.isStreaming = false;
    });
    render(<ChatInput onSend={onSend} onAbort={onAbort} />);
    fireEvent.click(screen.getByTestId('do-interrupt'));
    await vi.waitFor(() => expect(onAbort).toHaveBeenCalled());
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledWith('怎么停滞了', undefined));
    expect(chatState.composerQueue).toEqual([]);
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

  it('puts the draft back when send fails', async () => {
    onSend.mockResolvedValueOnce('failed');
    render(<ChatInput onSend={onSend} onAbort={vi.fn()} />);
    cleanDocument.mockClear();
    setDocument.mockClear();
    fireEvent.click(screen.getByTestId('do-send'));
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledWith('hello', undefined, undefined));
    expect(cleanDocument).toHaveBeenCalled();
    expect(setDocument).toHaveBeenCalledWith('markdown', 'hello');
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

describe('ChatInput send markdown unescape', () => {
  it('sends email without gfm autolink brackets', async () => {
    getDocument.mockReturnValue('hello <user@gmail.com>');
    render(<ChatInput onSend={onSend} onAbort={vi.fn()} />);
    fireEvent.click(screen.getByTestId('do-send'));
    await vi.waitFor(() =>
      expect(onSend).toHaveBeenCalledWith('hello user@gmail.com', undefined, undefined),
    );
  });

  it('sends email without a backslash before at-sign', async () => {
    getDocument.mockReturnValue('hello user\\@gmail.com');
    render(<ChatInput onSend={onSend} onAbort={vi.fn()} />);
    fireEvent.click(screen.getByTestId('do-send'));
    await vi.waitFor(() =>
      expect(onSend).toHaveBeenCalledWith('hello user@gmail.com', undefined, undefined),
    );
  });

  it('turns a picked browser element into a pasted chip', async () => {
    render(<ChatInput onSend={onSend} onAbort={vi.fn()} />);
    offerBrowserElementToChat({ title: 'button#go', text: '浏览器元素\n标签页 id: browser-9' });
    await vi.waitFor(() => expect(screen.getByTestId('pasted-count')).toHaveTextContent('1'));
    expect(screen.getByTestId('pasted-source')).toHaveTextContent('button#go');
  });
});
