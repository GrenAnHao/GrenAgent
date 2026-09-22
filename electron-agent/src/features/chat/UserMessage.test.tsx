import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { App } from 'antd';
import { UserMessage } from './UserMessage';

afterEach(cleanup);

const { storeState, fakeStore, useOptional } = vi.hoisted(() => {
  const storeState = {
    excluded: new Set<number>(),
    isStreaming: false,
    awaitingResponse: false,
    messages: [] as Array<{ kind: string; entryId?: string; timestamp?: number; text?: string }>,
  };
  const fakeStore = {
    useStore: (sel: (s: typeof storeState) => unknown) => sel(storeState),
    rewindAndLoad: () => {},
    regenerate: () => {},
    deleteFrom: () => {},
    excludeMessage: () => {},
    restoreMessage: () => {},
  };
  return {
    storeState,
    fakeStore,
    useOptional: vi.fn(() => ({ store: fakeStore, workspace: '.' })),
  };
});

vi.mock('../../stores/AgentStoreContext', () => ({
  useOptionalAgentStoreContext: () => useOptional(),
}));

const renderMsg = (text: string) =>
  render(
    <App>
      <ThemeProvider>
        <UserMessage text={text} />
      </ThemeProvider>
    </App>,
  );

describe('UserMessage', () => {
  afterEach(() => {
    storeState.excluded = new Set();
    storeState.isStreaming = false;
    storeState.awaitingResponse = false;
    storeState.messages = [];
    useOptional.mockImplementation(() => ({ store: fakeStore, workspace: '.' }));
  });

  it('把 pi:attachment 标记渲染成附件卡片, 正文进气泡', () => {
    const text =
      '看这个\n\n<pi:attachment type="file" path="src/config.ts" lines="42">\nconst x = 1\n</pi:attachment>';
    renderMsg(text);
    expect(screen.getByText('看这个')).toBeTruthy();
    expect(screen.getByText('config.ts')).toBeTruthy();
    expect(screen.getByText('42 行')).toBeTruthy();
    // 折叠态不直接显示文件内容
    expect(screen.queryByText('const x = 1')).toBeNull();
  });

  it('无标记的纯文本按原样渲染', () => {
    renderMsg('hello world');
    expect(screen.getByText('hello world')).toBeTruthy();
  });

  it('memory_extract 提示走预格式化，JSON 键单独成行', () => {
    const text = [
      'Extract durable memory as strict JSON. Return JSON only.',
      'Task kind: memory_extract',
      'Input: {"delta":"user: 你是什么模型?"}',
    ].join('\n');
    renderMsg(text);
    const pre = screen.getByTestId('structured-pre');
    expect(pre.textContent).toContain('Task kind: memory_extract');
    expect(pre.textContent).toContain('"delta"');
    expect(pre.textContent).toContain('你是什么模型?');
  });

  it('有文本时渲染复制按钮与更多菜单', () => {
    render(
      <App>
        <ThemeProvider>
          <UserMessage text="继续搜索上周的" />
        </ThemeProvider>
      </App>,
    );
    const actionBar = within(screen.getByTestId('message-action-bar'));
    expect(actionBar.getByTestId('msg-action-bar-copy')).toBeTruthy();
    expect(actionBar.getByRole('button', { name: '更多' })).toBeTruthy();
  });

  it('纯图片无文本时不渲染操作栏', () => {
    const { container } = render(
      <App>
        <ThemeProvider>
          <UserMessage text="" images={[{ mimeType: 'image/png', data: 'AAAA' }]} />
        </ThemeProvider>
      </App>,
    );
    expect(container.querySelector('.chat-actions')).toBeNull();
  });

  it('非最后一条用户消息：没有编辑、没有重新生成', async () => {
    storeState.messages = [
      { kind: 'user', entryId: 'e-old', timestamp: 1000, text: 'old' },
      { kind: 'assistant' },
      { kind: 'user', entryId: 'e-last', timestamp: 2000, text: 'last' },
      { kind: 'assistant' },
    ];
    render(
      <App>
        <ThemeProvider>
          <UserMessage text="old" entryId="e-old" timestamp={1000} />
        </ThemeProvider>
      </App>,
    );
    expect(screen.queryByTestId('msg-action-bar-edit')).toBeNull();
    screen.getByRole('button', { name: '更多' }).click();
    const menu = await screen.findByRole('menu');
    expect(menu.textContent).not.toContain('编辑');
    expect(menu.textContent).not.toContain('重新生成');
  });

  it('最后一条且后面有回复、对话停下：有编辑和重新生成', async () => {
    storeState.messages = [
      { kind: 'user', entryId: 'e-last', timestamp: 1000, text: 'last' },
      { kind: 'assistant' },
    ];
    render(
      <App>
        <ThemeProvider>
          <UserMessage text="last" entryId="e-last" timestamp={1000} />
        </ThemeProvider>
      </App>,
    );
    expect(screen.getByTestId('msg-action-bar-edit')).toBeTruthy();
    screen.getByRole('button', { name: '更多' }).click();
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('编辑')).toBeTruthy();
    expect(within(menu).getByText('重新生成')).toBeTruthy();
  });

  it('excluded：没有编辑、回退、重新生成、删除', async () => {
    storeState.excluded = new Set([1000]);
    storeState.messages = [
      { kind: 'user', entryId: 'e-ex', timestamp: 1000, text: 'ex' },
      { kind: 'assistant' },
      { kind: 'user', entryId: 'e-last', timestamp: 2000, text: 'last' },
    ];
    render(
      <App>
        <ThemeProvider>
          <UserMessage text="ex" entryId="e-ex" timestamp={1000} />
        </ThemeProvider>
      </App>,
    );
    expect(screen.getByText('已移出上下文')).toBeTruthy();
    expect(screen.queryByTestId('msg-action-bar-edit')).toBeNull();
    expect(screen.queryByTestId('msg-action-bar-rewind')).toBeNull();
    screen.getByRole('button', { name: '更多' }).click();
    const menu = await screen.findByRole('menu');
    expect(menu.textContent).not.toContain('编辑');
    expect(menu.textContent).not.toContain('回退到此');
    expect(menu.textContent).not.toContain('重新生成');
    expect(menu.textContent).not.toContain('删除');
  });
});
