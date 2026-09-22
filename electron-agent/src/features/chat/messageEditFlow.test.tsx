import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { App } from 'antd';
import type { ReactNode } from 'react';
import type { AgentState, ChatMessage } from '../../stores/agentReducer';
import type { AgentStoreApi } from '../../stores/agent';

const {
  truncateTo,
  writeUiHistory,
  deleteUiHistory,
  getMessages,
  abortEnhancePrompt,
  cancelPendingOverlay,
  getDocument,
  cleanDocument,
  setDocument,
} = vi.hoisted(() => ({
  truncateTo: vi.fn(
    (
      _ws: string,
      _entryId: string,
      _mode: 'drop-target' | 'keep-target',
    ): Promise<{ ok: true; lines: string[] } | { ok: false; reason: 'branched' }> =>
      Promise.resolve({ ok: true, lines: [] }),
  ),
  writeUiHistory: vi.fn((_ws: string, _key: string, _content: string) => Promise.resolve()),
  deleteUiHistory: vi.fn((_ws: string, _key: string) => Promise.resolve()),
  getMessages: vi.fn((_ws: string) => Promise.resolve({ messages: [] as unknown[] })),
  abortEnhancePrompt: vi.fn(() => Promise.resolve()),
  cancelPendingOverlay: vi.fn(() => Promise.resolve('idle' as const)),
  getDocument: vi.fn(() => '改后的文字'),
  cleanDocument: vi.fn(),
  setDocument: vi.fn(),
}));

vi.mock('../../lib/pi', () => ({
  pi: {
    truncateTo,
    writeUiHistory,
    deleteUiHistory,
    getMessages,
    abortEnhancePrompt,
  },
  onPiEvent: () => Promise.resolve(() => {}),
  onPiExit: () => Promise.resolve(() => {}),
}));

vi.mock('./input/overlayPrompt', () => ({ cancelPendingOverlay }));

vi.mock('@lobehub/editor/react', () => ({
  useEditor: () => ({
    getDocument,
    setDocument,
    cleanDocument,
    focus: vi.fn(),
    isEmpty: false,
    getLexicalEditor: () => null,
    dispatchCommand: vi.fn(),
  }),
  Editor: () => <div data-testid="message-edit-editor" />,
}));

vi.mock('./input/editor/InputChips', () => ({ InputChips: () => null }));
vi.mock('./input/editor/ChatTag/ReactChatTagPlugin', () => ({ default: {} }));
vi.mock('./input/editor/SlashBoxMenu', () => ({ createBoxMenu: () => () => null }));
vi.mock('./input/editor/useCommandPaste', () => ({ useCommandPaste: () => ({ tryCommandPaste: vi.fn() }) }));
vi.mock('./input/editor/useUrlPaste', () => ({ useUrlPaste: () => ({ tryUrlPaste: vi.fn() }) }));
vi.mock('./input/editor/usePasteCapture', () => ({ usePasteCapture: () => undefined }));
vi.mock('./input/editor/useFileMention', () => ({
  useFileMention: () => ({ mentionItems: [], onSelect: vi.fn() }),
}));
vi.mock('./input/editor/useSlashOptions', () => ({
  useSlashOptions: () => ({ slashItems: async () => [], onSelect: vi.fn() }),
}));
vi.mock('./input/editor/useTauriFileDrop', () => ({
  useTauriFileDrop: () => ({ dragOver: false, dragKind: null }),
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

vi.mock('../../store', () => ({
  useSessionStore: Object.assign(
    (sel: (s: { activeSessionPath: string }) => unknown) => sel({ activeSessionPath: '/ws/sessions/s.jsonl' }),
    { getState: () => ({ activeSessionPath: '/ws/sessions/s.jsonl' }) },
  ),
}));

vi.mock('../../stores/chatDraftStore', () => ({
  useChatDraftStore: {
    getState: () => ({ setDraft: vi.fn(), clearDraft: vi.fn(), getDraft: () => '' }),
  },
}));

import { createAgentStore } from '../../stores/agent';
import { AgentStoreContext } from '../../stores/AgentStoreContext';
import { UserMessage } from './UserMessage';
import { registerComposerSend, registerComposerSetValue } from './input/composerBridge';
import { ChatInput } from './ChatInput';

function wrap(store: AgentStoreApi, node: ReactNode) {
  return (
    <App>
      <ThemeProvider>
        <AgentStoreContext.Provider
          value={{
            workspace: '/ws',
            store,
            workspaceReady: true,
            setWorkspaceReady: () => undefined,
            appBooted: true,
          }}
        >
          {node}
        </AgentStoreContext.Provider>
      </ThemeProvider>
    </App>
  );
}

function seedUser(store: AgentStoreApi, entryId: string, text: string) {
  const msg: ChatMessage = {
    kind: 'user',
    id: 'local-1',
    text,
    entryId,
    timestamp: 1000,
  };
  store.useStore.setState({
    ...store.useStore.getState(),
    messages: [msg, { kind: 'assistant', id: 'a1', text: '回复', thinking: '', streaming: false }],
  } as AgentState);
}

describe('messageEditFlow', () => {
  let store: AgentStoreApi;
  const composerValues: string[] = [];
  const normalSend = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    truncateTo.mockReset().mockResolvedValue({ ok: true, lines: [] });
    writeUiHistory.mockReset().mockResolvedValue(undefined);
    deleteUiHistory.mockReset().mockResolvedValue(undefined);
    getMessages.mockReset().mockResolvedValue({ messages: [] });
    abortEnhancePrompt.mockReset().mockResolvedValue(undefined);
    cancelPendingOverlay.mockReset().mockResolvedValue('idle');
    getDocument.mockReturnValue('改后的文字');
    composerValues.length = 0;
    normalSend.mockReset().mockResolvedValue(undefined);
    store = createAgentStore('/ws');
    store.loadMessages([], { force: true, sessionPath: '/ws/sessions/s.jsonl' });
    registerComposerSetValue((text) => {
      composerValues.push(text);
    });
    registerComposerSend((text, images) => normalSend(text, images));
  });

  afterEach(() => {
    registerComposerSetValue(null);
    registerComposerSend(null);
    store.destroy();
    cleanup();
  });

  it('编辑取消不调用截断', async () => {
    seedUser(store, 'entry-u1', '原文');
    render(wrap(store, <UserMessage text="原文" entryId="entry-u1" timestamp={1000} />));

    fireEvent.click(screen.getByTestId('msg-action-bar-edit'));
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(truncateTo).not.toHaveBeenCalled();
    expect(screen.getByText('原文')).toBeTruthy();
  });

  it('编辑发送调用 drop-target 后再发送', async () => {
    seedUser(store, 'entry-u1', '原文');
    render(wrap(store, <UserMessage text="原文" entryId="entry-u1" timestamp={1000} />));

    fireEvent.click(screen.getByTestId('msg-action-bar-edit'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
    });

    expect(truncateTo).toHaveBeenCalledWith('/ws', 'entry-u1', 'drop-target');
    expect(normalSend).toHaveBeenCalledWith('改后的文字', undefined);
  });

  it('截断成功但发送失败时把文字写入底部输入框', async () => {
    seedUser(store, 'entry-u1', '原文');
    normalSend.mockRejectedValueOnce(new Error('send failed'));
    render(wrap(store, <UserMessage text="原文" entryId="entry-u1" timestamp={1000} />));

    fireEvent.click(screen.getByTestId('msg-action-bar-edit'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
    });

    expect(truncateTo).toHaveBeenCalledWith('/ws', 'entry-u1', 'drop-target');
    expect(composerValues).toContain('改后的文字');
  });

  it('回退确认调用截断后，下一次发送不再带截断', async () => {
    seedUser(store, 'entry-u1', '原文');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onSend = vi.fn(() => Promise.resolve());
    getDocument.mockReturnValue('原文');
    setDocument.mockClear();

    render(
      wrap(
        store,
        <>
          <UserMessage text="原文" entryId="entry-u1" timestamp={1000} />
          <ChatInput onSend={onSend} onAbort={vi.fn()} />
        </>,
      ),
    );

    const bar = within(screen.getByTestId('message-action-bar'));
    await act(async () => {
      fireEvent.click(bar.getByTestId('msg-action-bar-rewind'));
    });

    expect(confirmSpy).toHaveBeenCalled();
    expect(truncateTo).toHaveBeenCalledWith('/ws', 'entry-u1', 'drop-target');
    // ChatInput 挂载后接管 setValue：回退入框会走 editor.setDocument
    expect(setDocument).toHaveBeenCalledWith('markdown', '原文');

    truncateTo.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('do-send'));
    });

    expect(truncateTo).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
