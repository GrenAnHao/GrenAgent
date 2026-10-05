import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from 'antd';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MessageActionBar } from './MessageActionBar';

// 假 store 上下文：让带 timestamp/entryId 的 ctx 走 ContextBar，并可控 isStreaming / excluded / messages。
const { storeState, fakeStore } = vi.hoisted(() => {
  const storeState = {
    excluded: new Set<number>(),
    isStreaming: false,
    awaitingResponse: false,
    messages: [] as Array<{ kind: string; entryId?: string; timestamp?: number }>,
  };
  return {
    storeState,
    fakeStore: {
      useStore: (sel: (s: typeof storeState) => unknown) => sel(storeState),
      excludeMessage: () => {},
      restoreMessage: () => {},
      rewindTo: () => {},
      rewindAndLoad: () => {},
      regenerate: () => {},
      deleteFrom: () => {},
    },
  };
});
vi.mock('../../../stores/AgentStoreContext', () => ({
  useOptionalAgentStoreContext: () => ({ store: fakeStore, workspace: '.' }),
}));

afterEach(() => {
  cleanup();
  storeState.isStreaming = false;
  storeState.awaitingResponse = false;
  storeState.excluded = new Set();
  storeState.messages = [];
});

function renderBar() {
  return render(
    <App>
      <MessageActionBar
        ctx={{ role: 'user', text: 'hello' }}
        bar={['regenerate', 'edit', 'copy']}
        menu={['edit', 'copy', 'divider', 'regenerate', 'del']}
      />
    </App>,
  );
}

function bar() {
  return within(screen.getByTestId('message-action-bar'));
}

describe('MessageActionBar', () => {
  it('bar 渲染三个图标按钮 + 更多按钮', () => {
    renderBar();
    expect(bar().getByTestId('msg-action-bar-copy')).toBeTruthy();
    expect(bar().getByTestId('msg-action-bar-edit')).toBeTruthy();
    expect(bar().getByTestId('msg-action-bar-regenerate')).toBeTruthy();
    expect(bar().getByRole('button', { name: '更多' })).toBeTruthy();
  });

  it('点击复制写剪贴板', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderBar();
    bar().getByTestId('msg-action-bar-copy').click();
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('编辑按钮 disabled', () => {
    renderBar();
    expect(bar().getByTestId('msg-action-bar-edit').getAttribute('tabindex')).toBe('-1');
  });
});

function renderContextBar(overrides?: {
  bar?: Array<'rewind' | 'edit' | 'copy' | 'exclude'>;
  menu?: Array<'copy' | 'divider' | 'rewind' | 'edit' | 'regenerate' | 'del' | 'exclude'>;
  ctx?: { role: 'user'; text: string; timestamp?: number; entryId?: string; onEdit?: () => void };
}) {
  return render(
    <App>
      <MessageActionBar
        ctx={overrides?.ctx ?? { role: 'user', text: 'hi', timestamp: 1000, entryId: 'e-last', onEdit: () => {} }}
        bar={overrides?.bar ?? ['rewind', 'edit', 'copy']}
        menu={overrides?.menu ?? ['copy', 'divider', 'rewind', 'edit', 'regenerate', 'del']}
      />
    </App>,
  );
}

describe('MessageActionBar 流式门控（ContextBar）', () => {
  it('非流式：显示悬浮操作栏（含回退）', () => {
    storeState.isStreaming = false;
    storeState.messages = [
      { kind: 'user', entryId: 'e-last', timestamp: 1000 },
      { kind: 'assistant' },
    ];
    renderContextBar();
    expect(screen.getByTestId('message-action-bar')).toBeTruthy();
    expect(screen.getByTestId('msg-action-bar-rewind')).toBeTruthy();
  });

  it('流式进行中：仍渲染操作栏，有回退、没有复制和编辑', () => {
    storeState.isStreaming = true;
    storeState.messages = [{ kind: 'user', entryId: 'e-last', timestamp: 1000 }];
    renderContextBar();
    expect(screen.getByTestId('message-action-bar')).toBeTruthy();
    expect(screen.getByTestId('msg-action-bar-rewind')).toBeTruthy();
    expect(screen.queryByTestId('msg-action-bar-copy')).toBeNull();
    expect(screen.queryByTestId('msg-action-bar-edit')).toBeNull();
  });

  it('有 entryId、没有 timestamp、正在流式：仍有可用回退，没有编辑', () => {
    storeState.isStreaming = true;
    storeState.messages = [{ kind: 'user', entryId: 'e-stream' }];
    renderContextBar({
      ctx: { role: 'user', text: 'hi', entryId: 'e-stream' },
    });
    const rewind = screen.getByTestId('msg-action-bar-rewind');
    expect(rewind).toBeTruthy();
    expect(rewind.getAttribute('tabindex')).not.toBe('-1');
    expect(screen.queryByTestId('msg-action-bar-edit')).toBeNull();
  });

  it('用户消息栏位：编辑可访问名称是「编辑」，菜单无「移出上下文」', async () => {
    storeState.isStreaming = false;
    storeState.messages = [
      { kind: 'user', entryId: 'e-last', timestamp: 1000 },
      { kind: 'assistant' },
    ];
    renderContextBar();
    expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '编辑（即将支持）' })).toBeNull();

    screen.getByRole('button', { name: '更多' }).click();
    const menu = await screen.findByRole('menu');
    expect(menu.textContent).not.toContain('移出上下文');
    expect(within(menu).getByText('编辑')).toBeTruthy();
  });

  it('非最后一条用户消息：没有编辑、没有重新生成', async () => {
    storeState.isStreaming = false;
    storeState.messages = [
      { kind: 'user', entryId: 'e-old', timestamp: 1000 },
      { kind: 'assistant' },
      { kind: 'user', entryId: 'e-last', timestamp: 2000 },
      { kind: 'assistant' },
    ];
    renderContextBar({
      ctx: { role: 'user', text: 'old', timestamp: 1000, entryId: 'e-old', onEdit: () => {} },
    });
    expect(screen.queryByTestId('msg-action-bar-edit')).toBeNull();
    screen.getByRole('button', { name: '更多' }).click();
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByText('编辑')).toBeNull();
    expect(within(menu).queryByText('重新生成')).toBeNull();
    expect(within(menu).getByText('回退到此')).toBeTruthy();
  });

  it('已压缩分隔之前没有回退和编辑', async () => {
    storeState.messages = [
      { kind: 'user', entryId: 'e-old', timestamp: 1000 },
      { kind: 'assistant' },
      { kind: 'compaction' },
      { kind: 'user', entryId: 'e-new', timestamp: 2000 },
      { kind: 'assistant' },
    ];
    renderContextBar({
      ctx: { role: 'user', text: 'old', timestamp: 1000, entryId: 'e-old', onEdit: () => {} },
    });
    expect(screen.queryByTestId('msg-action-bar-edit')).toBeNull();
    expect(screen.queryByTestId('msg-action-bar-rewind')).toBeNull();
    screen.getByRole('button', { name: '更多' }).click();
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByText('编辑')).toBeNull();
    expect(within(menu).queryByText('回退到此')).toBeNull();
  });

  it('已压缩之后的最后一条仍可编辑', async () => {
    storeState.isStreaming = false;
    storeState.messages = [
      { kind: 'user', entryId: 'e-last', timestamp: 1000 },
      { kind: 'assistant' },
    ];
    renderContextBar({
      ctx: { role: 'user', text: 'hi', timestamp: 1000, entryId: 'e-last', onEdit: () => {} },
    });
    expect(screen.getByTestId('msg-action-bar-edit')).toBeTruthy();
    screen.getByRole('button', { name: '更多' }).click();
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('编辑')).toBeTruthy();
    expect(within(menu).getByText('重新生成')).toBeTruthy();
  });

  it('excluded：没有编辑、回退、重新生成、删除', async () => {
    storeState.isStreaming = false;
    storeState.excluded = new Set([1000]);
    storeState.messages = [
      { kind: 'user', entryId: 'e-ex', timestamp: 1000 },
      { kind: 'assistant' },
      { kind: 'user', entryId: 'e-last', timestamp: 2000 },
    ];
    renderContextBar({
      ctx: { role: 'user', text: 'ex', timestamp: 1000, entryId: 'e-ex', onEdit: () => {} },
    });
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
