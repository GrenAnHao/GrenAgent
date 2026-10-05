// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_CHAT_BRAND_GAP, EMPTY_CHAT_BRAND_SIZE, EmptyChatPrompt } from './EmptyChatPrompt';
import { useSidebarPrefsStore } from '../../stores/sidebarPrefsStore';

beforeEach(() => {
  useSidebarPrefsStore.setState({ aliases: {} });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('EmptyChatPrompt', () => {
  it('puts a tight 23px pi to the left of the conversation title', () => {
    render(<EmptyChatPrompt workspace="/works/demo" isConversation />);
    expect(screen.getByRole('heading', { name: '我们该做什么？' })).toBeTruthy();
    const logo = screen.getByTestId('empty-chat-brand');
    expect(logo.getAttribute('viewBox')).toBe('40 56 160 134');
    expect(logo.getAttribute('height')).toBe('23');
    expect(screen.getByTestId('empty-chat-lockup')).toHaveStyle({ gap: '9px' });
  });

  it('uses the same lockup for a project empty state', () => {
    render(<EmptyChatPrompt workspace="D:\\repo\\JSReverser-MCP" isConversation={false} />);
    expect(screen.getByRole('heading', { name: '我们应该在 JSReverser-MCP 中构建什么？' })).toBeTruthy();
    expect(screen.getByTestId('empty-chat-brand')).toBeTruthy();
  });

  it('lets a long project title use the compose column instead of a 520px cap', () => {
    render(<EmptyChatPrompt workspace="D:\\repo\\electron-mall-manager" isConversation={false} />);
    const heading = screen.getByRole('heading', { name: '我们应该在 electron-mall-manager 中构建什么？' });
    const reserve = EMPTY_CHAT_BRAND_SIZE + EMPTY_CHAT_BRAND_GAP;
    expect(getComputedStyle(heading).maxWidth).toBe(`calc(100% - ${reserve}px)`);
    expect(getComputedStyle(screen.getByTestId('empty-chat-lockup')).width).toBe('100%');
  });
});
