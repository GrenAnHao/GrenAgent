import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DisplayMessage } from './groupMessages';

const scrollToIndex = vi.fn();
let lastOnScroll: (() => void) | undefined;

vi.mock('virtua', async () => {
  const React = await import('react');
  return {
    VList: React.forwardRef(function MockVList({ children, data, onScroll, ...props }: any, ref: any) {
      lastOnScroll = onScroll;
      React.useImperativeHandle(ref, () => ({
        scrollToIndex,
        scrollOffset: 0,
        viewportSize: 600,
        scrollSize: 40_000,
        findItemIndex: () => 0,
        getItemOffset: () => 0,
      }));
      const items = typeof children === 'function' ? Array.from(data ?? [], children) : children;
      return React.createElement('div', props, items);
    }),
  };
});

import { VirtualizedMessageList } from './VirtualizedMessageList';

afterEach(() => {
  cleanup();
  scrollToIndex.mockClear();
  lastOnScroll = undefined;
});

beforeEach(() => {
  scrollToIndex.mockClear();
  lastOnScroll = undefined;
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

function renderList() {
  return render(
    <VirtualizedMessageList
      display={longConversation()}
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

  it('从列表顶部回到底部时瞬时落点，不沿途平滑滚', () => {
    renderList();

    fireEvent.wheel(screen.getByTestId('vlist'), { deltaY: -80 });
    act(() => {
      lastOnScroll?.();
    });

    fireEvent.click(screen.getByRole('button', { name: '回到底部' }));

    expect(scrollToIndex).toHaveBeenCalledWith(23, {
      align: 'end',
      smooth: false,
    });
  });
});
