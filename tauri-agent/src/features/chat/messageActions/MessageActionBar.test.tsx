import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from 'antd';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MessageActionBar } from './MessageActionBar';

afterEach(cleanup);

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
