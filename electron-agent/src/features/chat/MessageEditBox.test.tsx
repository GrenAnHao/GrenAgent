// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
  useAgentStore: () => ({
    useStore: (sel: (s: Record<string, unknown>) => unknown) => sel({}),
  }),
}));

vi.mock('@lobehub/editor/react', () => ({
  useEditor: () => ({
    setDocument: vi.fn(),
    getDocument: vi.fn(() => '继续搜索上周的'),
    cleanDocument: vi.fn(),
    focus: vi.fn(),
    isEmpty: false,
    getLexicalEditor: () => null,
    dispatchCommand: vi.fn(),
  }),
  Editor: ({ content }: { content?: string }) => (
    <div data-testid="message-edit-editor">{content}</div>
  ),
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

import { MessageEditBox } from './MessageEditBox';

afterEach(cleanup);

describe('MessageEditBox', () => {
  it('预填文字，只有取消和发送，没有模型；取消调用 onCancel', () => {
    const onCancel = vi.fn();
    const onSend = vi.fn();

    render(
      <MessageEditBox initialText="继续搜索上周的" onCancel={onCancel} onSend={onSend} />,
    );

    expect(screen.getByTestId('message-edit-editor').textContent).toBe('继续搜索上周的');
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '发送' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '模型' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });
});
