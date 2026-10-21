import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { create } from 'zustand';
import { ThemeProvider } from '@lobehub/ui';
import { App } from 'antd';
import { buildCommandBlock } from '@extensions/prompt-commands/syntax';
import { UserMessage } from './UserMessage';

const { loadIntoComposer } = vi.hoisted(() => ({ loadIntoComposer: vi.fn(() => true) }));
vi.mock('./input/composerBridge', () => ({ loadIntoComposer }));

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
    rewindAndLoad: vi.fn(),
    cancelSteer: vi.fn(async (_id: string): Promise<'cancelled' | 'missed'> => 'cancelled'),
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
    fakeStore.cancelSteer.mockReset();
    fakeStore.cancelSteer.mockResolvedValue('cancelled');
    loadIntoComposer.mockClear();
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

  it('已压缩之前的用户消息没有编辑和回退', () => {
    storeState.messages = [
      { kind: 'user', entryId: 'e-old', timestamp: 1000, text: 'old' },
      { kind: 'assistant' },
      { kind: 'compaction' },
    ];
    render(
      <App>
        <ThemeProvider>
          <UserMessage text="old" entryId="e-old" timestamp={1000} />
        </ThemeProvider>
      </App>,
    );
    expect(screen.queryByTestId('msg-action-bar-edit')).toBeNull();
    expect(screen.queryByTestId('msg-action-bar-rewind')).toBeNull();
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

  it('引导消息按下落显示状态', () => {
    const { rerender } = render(
      <App>
        <ThemeProvider>
          <UserMessage text="记住账号密码" steering steerState="written" />
        </ThemeProvider>
      </App>,
    );
    expect(screen.getByTestId('steer-status').textContent).toContain('正在引导…');
    expect(screen.getByLabelText('正在重定向正在运行的这一轮，尚未确认。')).toBeTruthy();

    rerender(
      <App>
        <ThemeProvider>
          <UserMessage text="记住账号密码" steering steerState="consumed" />
        </ThemeProvider>
      </App>,
    );
    expect(screen.getByTestId('steer-status').textContent).toContain('已引导到正在运行的这一轮');
    expect(screen.queryByLabelText('正在重定向正在运行的这一轮，尚未确认。')).toBeNull();

    rerender(
      <App>
        <ThemeProvider>
          <UserMessage text="记住账号密码" steering steerState="requeued" />
        </ThemeProvider>
      </App>,
    );
    expect(screen.getByTestId('steer-status').textContent).toContain('这一轮在此生效前已结束，此消息作为独立消息运行。');
  });

  it('普通用户消息不显示引导状态', () => {
    renderMsg('hello');
    expect(screen.queryByTestId('steer-status')).toBeNull();
  });

  it('timestamp 从无到有时不因多调 useStore 崩溃', () => {
    const real = create(() => ({
      excluded: new Set<number>(),
      isStreaming: false,
      awaitingResponse: false,
      messages: [{ kind: 'user', text: 'hi' }],
    }));
    useOptional.mockImplementation(() => ({
      store: { ...fakeStore, useStore: real },
      workspace: '.',
    }));
    const ui = render(
      <App>
        <ThemeProvider>
          <UserMessage text="hi" />
        </ThemeProvider>
      </App>,
    );
    ui.rerender(
      <App>
        <ThemeProvider>
          <UserMessage text="hi" timestamp={1000} entryId="e1" />
        </ThemeProvider>
      </App>,
    );
    expect(screen.getByText('hi')).toBeTruthy();
  });

  describe('命令消息', () => {
    const commandText = `${buildCommandBlock('refactor', [{ name: 'file', value: 'a.ts' }], '模板正文')}\n\n顺便看看`;
    const invocation = '/refactor "a.ts" 顺便看看';

    it('复制得到调用文本，而不是 <command 原文', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      renderMsg(commandText);
      screen.getByTestId('msg-action-bar-copy').click();
      await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
      expect(writeText).toHaveBeenCalledWith(invocation);
      expect(writeText.mock.calls[0]![0]).not.toContain('<command');
    });

    it('编辑（后面还没有回复）把调用文本放回输入框', () => {
      storeState.messages = [{ kind: 'user', entryId: 'e-last', timestamp: 1000, text: commandText }];
      render(
        <App>
          <ThemeProvider>
            <UserMessage text={commandText} entryId="e-last" timestamp={1000} />
          </ThemeProvider>
        </App>,
      );
      screen.getByTestId('msg-action-bar-edit').click();
      expect(fakeStore.rewindAndLoad).toHaveBeenCalledWith('e-last', invocation);
    });
  });
  describe('等待中的引导', () => {
    const image = { mimeType: 'image/png', data: 'AAAA' };
    const renderSteer = (steerState: 'written' | 'consumed' | 'requeued') => {
      storeState.isStreaming = true;
      return render(
        <App>
          <ThemeProvider>
            <UserMessage id="s1" text="改用 chrome" images={[image]} steering steerState={steerState} />
          </ThemeProvider>
        </App>,
      );
    };

    it('操作栏是取消（X）、编辑、复制，没有回退和更多菜单，执行中也在', () => {
      renderSteer('written');
      const bar = within(screen.getByTestId('message-action-bar'));
      const keys = Array.from(screen.getByTestId('message-action-bar').querySelectorAll('[data-testid^="msg-action-bar-"]'))
        .map((el) => el.getAttribute('data-testid'));
      expect(keys).toEqual(['msg-action-bar-cancel', 'msg-action-bar-edit', 'msg-action-bar-copy']);
      expect(bar.getByRole('button', { name: '取消引导' })).toBeTruthy();
      expect(bar.queryByRole('button', { name: '更多' })).toBeNull();
    });

    it('点 X 按消息 id 撤下引导，不往输入框里放', async () => {
      renderSteer('written');
      screen.getByTestId('msg-action-bar-cancel').click();
      await vi.waitFor(() => expect(fakeStore.cancelSteer).toHaveBeenCalledWith('s1'));
      expect(loadIntoComposer).not.toHaveBeenCalled();
    });

    it('编辑先取消，撤成功后把原文和图片放回输入框', async () => {
      renderSteer('written');
      screen.getByTestId('msg-action-bar-edit').click();
      await vi.waitFor(() => expect(loadIntoComposer).toHaveBeenCalledWith('改用 chrome', [image]));
      expect(fakeStore.cancelSteer).toHaveBeenCalledWith('s1');
    });

    it('已经在注入、撤不回来时不放回输入框', async () => {
      fakeStore.cancelSteer.mockResolvedValue('missed');
      renderSteer('written');
      screen.getByTestId('msg-action-bar-edit').click();
      await vi.waitFor(() => expect(fakeStore.cancelSteer).toHaveBeenCalled());
      await Promise.resolve();
      expect(loadIntoComposer).not.toHaveBeenCalled();
    });

    it('已引导的消息没有取消按钮', () => {
      renderSteer('consumed');
      expect(screen.queryByTestId('msg-action-bar-cancel')).toBeNull();
    });
  });
});
