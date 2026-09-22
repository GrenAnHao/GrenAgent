// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ISlashOption } from '@lobehub/editor';

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

vi.mock('./input/editor/InputChips', async () => {
  const { useChatInput } = await import('./input/ChatInputContext');
  return {
    InputChips: () => {
      const { attachments } = useChatInput();
      if (!attachments.length) return null;
      return (
        <div data-testid="message-edit-chips">
          {attachments.map((a, i) => (
            <img key={`${a.name}-${i}`} alt={a.name} src={a.url} data-testid="message-edit-image" />
          ))}
        </div>
      );
    },
  };
});
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

import { filterSkillSlashOptions, MessageEditBox } from './MessageEditBox';

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

  it('给定初始图片时显示图片块', () => {
    render(
      <MessageEditBox
        initialText="带图"
        initialImages={[{ mimeType: 'image/png', data: 'AAAA' }]}
        onCancel={vi.fn()}
        onSend={vi.fn()}
      />,
    );

    const img = screen.getByTestId('message-edit-image') as HTMLImageElement;
    expect(img.src).toContain('data:image/png;base64,AAAA');
    expect(img.alt).toBe('image-1');
  });
});

describe('filterSkillSlashOptions', () => {
  it('只保留 metadata.group === skill，不依赖中文分组标题', () => {
    const items: ISlashOption[] = [
      { type: 'divider', label: '快捷操作' },
      { key: 'frontend:compact', label: 'compact', metadata: { group: 'frontend' } },
      { type: 'divider', label: 'ANY_LOCALIZED_SKILL_HEADER' },
      {
        key: 'api:skill:caveman',
        label: 'caveman',
        metadata: { group: 'skill', kind: 'api', name: 'skill:caveman' },
      },
      { key: 'api:help', label: 'help', metadata: { group: 'builtin' } },
    ];

    const filtered = filterSkillSlashOptions(items);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toMatchObject({
      key: 'api:skill:caveman',
      metadata: { group: 'skill' },
    });
    // 分组标题（含任意本地化文案）全部丢弃；只靠 group 字段。
    expect(filtered.every((item) => !('type' in item && item.type === 'divider'))).toBe(true);
  });
});
