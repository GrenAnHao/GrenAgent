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

function renderContextBar() {
  return render(
    <App>
      <MessageActionBar
        ctx={{ role: 'assistant', text: 'hi', timestamp: 1000 }}
        bar={['rewind', 'exclude', 'copy']}
        menu={['copy', 'divider', 'rewind', 'exclude']}
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

  it('流式进行中：隐藏整条操作栏（不在回合进行中暴露回退/移出）', () => {
    storeState.isStreaming = true;
    renderContextBar();
    expect(screen.queryByTestId('message-action-bar')).toBeNull();
  });
});
