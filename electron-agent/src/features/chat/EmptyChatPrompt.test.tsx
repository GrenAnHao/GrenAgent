// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_CHAT_BRAND_GAP, EmptyChatPrompt } from './EmptyChatPrompt';
import { useSidebarPrefsStore } from '../../stores/sidebarPrefsStore';

beforeEach(() => {
  useSidebarPrefsStore.setState({ aliases: {} });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('EmptyChatPrompt', () => {
  it('identifies a standalone conversation separately from the task heading', () => {
    render(<EmptyChatPrompt workspace="/works/demo" isConversation />);
    expect(screen.getByRole('heading', { name: '想在这里完成什么？' })).toBeTruthy();
    expect(screen.getByTestId('empty-chat-lockup')).toHaveTextContent('新对话');
    const logo = screen.getByTestId('empty-chat-brand');
    expect(logo.getAttribute('viewBox')).toBe('0 0 352 352');
    expect(logo.getAttribute('height')).toBe('18');
    expect(screen.getByTestId('empty-chat-lockup')).toHaveStyle({ gap: `${EMPTY_CHAT_BRAND_GAP}px` });
  });

  it('uses the same lockup for a project empty state', () => {
    render(<EmptyChatPrompt workspace="D:\\repo\\JSReverser-MCP" isConversation={false} />);
    expect(screen.getByRole('heading', { name: '想在这里完成什么？' })).toBeTruthy();
    expect(screen.getByTestId('empty-chat-lockup')).toHaveTextContent('JSReverser-MCP');
    expect(screen.getByTestId('empty-chat-brand')).toBeTruthy();
  });

  it('keeps the project alias in the context line instead of lengthening the heading', () => {
    const workspace = 'D:\\repo\\electron-mall-manager';
    useSidebarPrefsStore.setState({ aliases: { [workspace]: '省心掌柜的长项目名称' } });
    render(<EmptyChatPrompt workspace={workspace} isConversation={false} />);
    expect(screen.getByRole('heading', { name: '想在这里完成什么？' })).toBeTruthy();
    expect(screen.getByTestId('empty-chat-lockup')).toHaveTextContent('省心掌柜的长项目名称');
  });
});
