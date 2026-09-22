import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from 'antd';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MessageActionBar } from './MessageActionBar';

// 假 store 上下文：让带 timestamp 的 ctx 走 ContextBar，并可控 isStreaming / excluded。
const { storeState, fakeStore } = vi.hoisted(() => {
  const storeState = { excluded: new Set<number>(), isStreaming: false };
  return {
    storeState,
    fakeStore: {
      useStore: (sel: (s: { excluded: Set<number>; isStreaming: boolean }) => unknown) => sel(storeState),
      excludeMessage: () => {},
      restoreMessage: () => {},
      rewindTo: () => {},
    },
  };
});
vi.mock('../../../stores/AgentStoreContext', () => ({
  useOptionalAgentStoreContext: () => ({ store: fakeStore, workspace: '.' }),
}));

afterEach(() => {
  cleanup();
  storeState.isStreaming = false;
  storeState.excluded = new Set();
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
}) {
  return render(
    <App>
      <MessageActionBar
        ctx={{ role: 'user', text: 'hi', timestamp: 1000 }}
        bar={overrides?.bar ?? ['rewind', 'edit', 'copy']}
        menu={overrides?.menu ?? ['copy', 'divider', 'rewind', 'edit', 'regenerate', 'del']}
      />
    </App>,
  );
}

describe('MessageActionBar 流式门控（ContextBar）', () => {
  it('非流式：显示悬浮操作栏（含回退）', () => {
    storeState.isStreaming = false;
    renderContextBar();
    expect(screen.getByTestId('message-action-bar')).toBeTruthy();
    expect(screen.getByTestId('msg-action-bar-rewind')).toBeTruthy();
  });

  it('流式进行中：仍渲染操作栏，有回退、没有编辑', () => {
    storeState.isStreaming = true;
    renderContextBar();
    expect(screen.getByTestId('message-action-bar')).toBeTruthy();
    expect(screen.getByTestId('msg-action-bar-rewind')).toBeTruthy();
    expect(screen.queryByTestId('msg-action-bar-edit')).toBeNull();
  });

  it('用户消息栏位：编辑可访问名称是「编辑」，菜单无「移出上下文」', async () => {
    storeState.isStreaming = false;
    renderContextBar();
    expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '编辑（即将支持）' })).toBeNull();

    screen.getByRole('button', { name: '更多' }).click();
    const menu = await screen.findByRole('menu');
    expect(menu.textContent).not.toContain('移出上下文');
    expect(within(menu).getByText('编辑')).toBeTruthy();
  });
});
