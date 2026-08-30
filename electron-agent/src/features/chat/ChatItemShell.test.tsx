import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { ChatItemShell } from './ChatItemShell';

afterEach(cleanup);

const wrap = (ui: React.ReactElement) =>
  render(<ThemeProvider themeMode="dark">{ui}</ThemeProvider>);

describe('ChatItemShell', { timeout: 30_000 }, () => {
  it('user 右对齐 + 气泡，无头像', () => {
    wrap(
      <ChatItemShell placement="right" bubble>
        <span>hi</span>
      </ChatItemShell>,
    );
    expect(screen.getByText('hi')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('assistant 左对齐全宽', () => {
    wrap(
      <ChatItemShell placement="left">
        <span>yo</span>
      </ChatItemShell>,
    );
    expect(screen.getByText('yo')).toBeTruthy();
  });

  it('actions 渲染在 .chat-actions 容器内', () => {
    const { container } = wrap(
      <ChatItemShell placement="right" bubble actions={<button>复制</button>}>
        正文
      </ChatItemShell>,
    );
    const actions = container.querySelector('.chat-actions');
    expect(actions).not.toBeNull();
    expect(actions!.textContent).toContain('复制');
  });

  it('无 actions 时不渲染 .chat-actions', () => {
    const { container } = wrap(
      <ChatItemShell placement="left">正文</ChatItemShell>,
    );
    expect(container.querySelector('.chat-actions')).toBeNull();
  });
});
