import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { DisplayMessage } from './groupMessages';
import type { MessageListViewport } from './VirtualizedMessageList';

const { scrollToIndex, scrollBy, fireScroll, onScrollRef } = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  scrollBy: vi.fn(),
  fireScroll: { current: false },
  onScrollRef: { current: null as null | (() => void) },
}));

vi.mock('virtua', async () => {
  const React = await import('react');
  return {
    VList: React.forwardRef(function MockVList({ children, data, style, ...props }: any, ref: any) {
      React.useImperativeHandle(ref, () => ({
        scrollToIndex,
        scrollBy,
        scrollOffset: 0,
        viewportSize: 600,
        scrollSize: 40_000,
        findItemIndex: () => 0,
        getItemOffset: () => 0,
      }));
      onScrollRef.current = props.onScroll ?? null;
      React.useEffect(() => {
        if (fireScroll.current) props.onScroll?.();
      }, []);
      const items = typeof children === 'function' ? Array.from(data ?? [], children) : children;
      return React.createElement('div', { ...props, style, 'data-testid': 'virtua-list' }, items);
    }),
  };
});

import { VirtualizedMessageList } from './VirtualizedMessageList';

afterEach(() => {
  cleanup();
  scrollToIndex.mockClear();
  scrollBy.mockClear();
  fireScroll.current = false;
});

beforeEach(() => {
  scrollToIndex.mockClear();
  scrollBy.mockClear();
  fireScroll.current = false;
});

function longConversation(): DisplayMessage[] {
  return Array.from({ length: 24 }, (_, i) =>
    i % 2 === 0
      ? ({ kind: 'user', id: `u${i}`, text: `问 ${i}` } satisfies DisplayMessage)
      : ({
          kind: 'turn',
          id: `t${i}`,
          segments: [{ kind: 'text', id: `t${i}-text`, content: `答 ${i}`, streaming: false }],
        } satisfies DisplayMessage),
  );
}

function renderList(overlay?: (viewport: MessageListViewport) => ReactNode) {
  return render(
    <VirtualizedMessageList
      display={longConversation()}
      overlay={overlay}
      renderItem={(m) => <div data-testid={`full-${m.id}`}>full-{m.id}</div>}
      data-testid="vlist"
    />,
  );
}

describe('VirtualizedMessageList', () => {
  it('mounts the scroll container with the given testid without crashing', () => {
    renderList();
    expect(screen.getByTestId('vlist')).toBeTruthy();
  });

  it('renders empty (no footer) without crashing', () => {
    const { getByTestId } = render(
      <VirtualizedMessageList display={[]} renderItem={() => null} data-testid="vlist-empty" />,
    );
    expect(getByTestId('vlist-empty')).toBeTruthy();
  });

  it('reserves seat padding as a trailing spacer row', () => {
    render(
      <VirtualizedMessageList
        display={longConversation()}
        renderItem={(m) => <div>{m.id}</div>}
        paddingBottom={120}
        data-testid="vlist"
      />,
    );
    expect(screen.getByTestId('seat-spacer').style.height).toBe('120px');
  });

  it('renders no spacer row when paddingBottom is 0', () => {
    render(
      <VirtualizedMessageList
        display={longConversation()}
        renderItem={(m) => <div>{m.id}</div>}
        data-testid="vlist"
      />,
    );
    expect(screen.queryByTestId('seat-spacer')).toBeNull();
  });

  it('lifts the jump button above the seat', () => {
    const scrollRef = { current: null as { scrollBy: (deltaY: number) => void } | null };
    render(
      <VirtualizedMessageList
        display={longConversation()}
        renderItem={(m) => <div>{m.id}</div>}
        paddingBottom={120}
        scrollRef={scrollRef}
        data-testid="vlist"
      />,
    );
    // 跟随判断读滚动容器的 DOM 几何；jsdom 全是 0，这里给一个可写的长列表，先贴在底部。
    const scroller = screen.getByTestId('virtua-list');
    let top = 39_400;
    Object.defineProperties(scroller, {
      scrollTop: { configurable: true, get: () => top, set: (v: number) => { top = Math.min(39_400, Math.max(0, v)); } },
      scrollHeight: { configurable: true, value: 40_000 },
      clientHeight: { configurable: true, value: 600 },
    });
    act(() => {
      onScrollRef.current?.();
      // 读者往上滚到中部，停手后浏览器发 scrollend，采样结果是离开底部。
      scrollRef.current?.scrollBy(-40);
      top = 20_000;
      onScrollRef.current?.();
      scroller.dispatchEvent(new Event('scrollend'));
    });
    expect(screen.getByTestId('jump-to-bottom')).toHaveStyle({ insetBlockEnd: '136px' });
  });
});
