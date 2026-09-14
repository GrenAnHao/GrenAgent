import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { DisplayMessage } from './groupMessages';
import type { MessageListViewport } from './VirtualizedMessageList';
import { SMOOTH_JUMP_MAX_ITEMS } from './listScrollPolicy';

const { scrollToIndex, scrollBy, fireScroll } = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  scrollBy: vi.fn(),
  fireScroll: { current: false },
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

  it('近距离时间轴跳转保留平滑滚动', () => {
    let viewport: MessageListViewport | undefined;
    renderList((vp) => {
      viewport = vp;
      return null;
    });

    act(() => {
      viewport!.scrollToIndex(SMOOTH_JUMP_MAX_ITEMS);
    });

    expect(scrollToIndex).toHaveBeenCalledWith(SMOOTH_JUMP_MAX_ITEMS, {
      align: 'start',
      smooth: true,
    });
  });

  it('大跨度时间轴跳转瞬时落点，不沿途平滑滚', () => {
    let viewport: MessageListViewport | undefined;
    renderList((vp) => {
      viewport = vp;
      return null;
    });

    act(() => {
      viewport!.scrollToIndex(20);
    });

    expect(scrollToIndex).toHaveBeenCalledWith(20, {
      align: 'start',
      smooth: false,
    });
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
    fireScroll.current = true;
    render(
      <VirtualizedMessageList
        display={longConversation()}
        renderItem={(m) => <div>{m.id}</div>}
        paddingBottom={120}
        data-testid="vlist"
      />,
    );
    expect(screen.getByTestId('jump-to-bottom')).toHaveStyle({ insetBlockEnd: '136px' });
  });
});
