// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DisplayMessage } from '../chat/groupMessages';
import type { MessageListViewport } from '../chat/VirtualizedMessageList';
import { ChatMiniMap } from './index';

afterEach(cleanup);

/** 每条列表条目的假高度：把手用它把条目下标换算成像素偏移。 */
const ITEM_PX = 100;

/** 可手动推进视口位置的假把手，替代真实 virtua 列表。 */
function createViewport() {
  let topIndex = 0;
  let scrollOffset = 0;
  const listeners = new Set<() => void>();

  const viewport: MessageListViewport = {
    scrollToIndex: vi.fn(),
    getTopIndex: () => topIndex,
    getScrollOffset: () => scrollOffset,
    getItemOffset: (index) => index * ITEM_PX,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    viewport,
    /** 把视口顶部挪到某条目；可额外指定像素偏移以模拟停在条目中间。 */
    moveTo(index: number, offset: number = index * ITEM_PX) {
      topIndex = index;
      scrollOffset = offset;
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}

/** 本项目未接线 jest-dom 匹配器，属性断言走原生 getAttribute。 */
const attr = (el: Element | null, name: string) => el?.getAttribute(name) ?? null;
const indicators = () => screen.getAllByRole('button', { name: /跳转到第 \d+ 条消息/ });
const lineWidths = () => indicators().map((el) => (el.firstElementChild as HTMLElement).style.width);

/**
 * jsdom 不做布局，rail 的 clientHeight / scrollHeight 都是 0；
 * 这里把它伪装成「8 条刻度共 80px、只露出 30px」的溢出状态，并把 scrollTop 变成可读写的普通属性。
 * 顺带抹掉 scrollTo，让平滑滚动走 scrollTop 赋值的回退路径，便于断言。
 */
function mockOverflowingRail() {
  const rail = screen.getByRole('group') as HTMLDivElement;
  Object.defineProperty(rail, 'clientHeight', { value: 30, configurable: true });
  Object.defineProperty(rail, 'scrollHeight', { value: 80, configurable: true });
  Object.defineProperty(rail, 'scrollTop', { value: 0, writable: true, configurable: true });
  Object.defineProperty(rail, 'scrollTo', { value: undefined, configurable: true });
  return rail;
}

const user = (id: string, text: string): DisplayMessage => ({ kind: 'user', id, text });
const turn = (id: string, reply: string): DisplayMessage => ({
  kind: 'turn',
  id,
  segments: [{ kind: 'text', id: `${id}-text`, content: reply, streaming: false }],
});

/** 四轮问答：用户消息落在下标 0/2/4/6，助手回复夹在中间。 */
const conversation: DisplayMessage[] = [
  user('u1', '第一个问题'),
  turn('a1', '第一轮回复'),
  user('u2', '第二个问题'),
  turn('a2', '第二轮回复'),
  user('u3', '第三个问题'),
  turn('a3', '第三轮回复'),
  user('u4', '第四个问题'),
  turn('a4', '第四轮回复'),
];

/** 八轮问答：用户消息落在偶数下标 0..14，用来验证 rail 溢出后的跟随。 */
const longConversation: DisplayMessage[] = Array.from({ length: 8 }, (_, i) => [
  user(`u${i}`, `第 ${i + 1} 个问题`),
  turn(`a${i}`, `第 ${i + 1} 轮回复`),
]).flat();

describe('ChatMiniMap', () => {
  it('只为用户消息生成刻度，默认统一长度且没有气泡', () => {
    const { viewport } = createViewport();
    render(<ChatMiniMap messages={conversation} viewport={viewport} />);

    expect(indicators()).toHaveLength(4);
    expect(lineWidths()).toEqual(['8px', '8px', '8px', '8px']);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('对话太短时不渲染', () => {
    const { viewport } = createViewport();
    render(<ChatMiniMap messages={conversation.slice(0, 5)} viewport={viewport} />);

    expect(screen.queryByTestId('chat-minimap')).toBeNull();
  });

  it('点击刻度跳到对应的列表条目', () => {
    const { viewport } = createViewport();
    render(<ChatMiniMap messages={conversation} viewport={viewport} />);

    fireEvent.click(screen.getByRole('button', { name: '跳转到第 3 条消息' }));

    expect(viewport.scrollToIndex).toHaveBeenCalledWith(4);
  });

  it('视口停在助手回复上时，高亮开启该轮的用户消息', () => {
    const { viewport, moveTo } = createViewport();
    render(<ChatMiniMap messages={conversation} viewport={viewport} />);

    expect(attr(indicators()[0], 'aria-current')).toBe('true');

    // 下标 3 是第二轮的助手回复，它自己没有刻度 → 高亮回退到第二条用户消息。
    moveTo(3);
    expect(attr(indicators()[1], 'aria-current')).toBe('true');
    expect(attr(indicators()[0], 'aria-current')).toBeNull();

    moveTo(6);
    expect(attr(indicators()[3], 'aria-current')).toBe('true');
  });

  it('悬停某条刻度：它最长、相邻逐级缩短，并弹出这一轮的问答摘要', () => {
    const { viewport } = createViewport();
    render(<ChatMiniMap messages={conversation} viewport={viewport} />);

    fireEvent.mouseEnter(indicators()[2]);

    expect(lineWidths()).toEqual(['13px', '18px', '24px', '18px']);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).toContain('第三个问题');
    expect(tooltip.textContent).toContain('第三轮回复');
  });

  it('移到另一条刻度时气泡跟着切换', () => {
    const { viewport } = createViewport();
    render(<ChatMiniMap messages={conversation} viewport={viewport} />);

    fireEvent.mouseEnter(indicators()[0]);
    expect(screen.getByRole('tooltip').textContent).toContain('第一个问题');

    fireEvent.mouseEnter(indicators()[3]);
    expect(screen.getByRole('tooltip').textContent).toContain('第四个问题');
    expect(lineWidths()).toEqual(['8px', '13px', '18px', '24px']);
  });

  it('移出 rail 后延迟关闭，刻度恢复统一长度', () => {
    vi.useFakeTimers();
    try {
      const { viewport } = createViewport();
      render(<ChatMiniMap messages={conversation} viewport={viewport} />);

      fireEvent.mouseEnter(indicators()[1]);
      expect(screen.getByRole('tooltip')).toBeTruthy();

      fireEvent.mouseLeave(screen.getByRole('group'));
      // 延迟窗口内仍然开着，在相邻刻度之间掠过不会闪。
      expect(screen.getByRole('tooltip')).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.queryByRole('tooltip')).toBeNull();
      expect(lineWidths()).toEqual(['8px', '8px', '8px', '8px']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rail 溢出时随视口连续滚动，让当前刻度居中，两端夹紧', () => {
    const { viewport, moveTo } = createViewport();
    render(<ChatMiniMap messages={longConversation} viewport={viewport} />);
    const rail = mockOverflowingRail();

    // 第 5 条刻度（列表下标 8）居中：中线 45px - 半个 rail 15px。
    moveTo(8);
    expect(rail.scrollTop).toBe(30);

    // 视口在下标 8 与 10 两条用户消息之间滚过一半像素 → 刻度位置 4.5，rail 跟着走半格，而不是停在原地等换条。
    moveTo(9, 900);
    expect(rail.scrollTop).toBe(35);

    moveTo(0);
    expect(rail.scrollTop).toBe(0);
    moveTo(14);
    expect(rail.scrollTop).toBe(50);
  });

  it('悬停 rail 期间暂停跟随，移出后滑回当前位置', () => {
    const { viewport, moveTo } = createViewport();
    render(<ChatMiniMap messages={longConversation} viewport={viewport} />);
    const rail = mockOverflowingRail();

    fireEvent.mouseEnter(indicators()[0]);
    moveTo(8);
    expect(rail.scrollTop).toBe(0);

    fireEvent.mouseLeave(rail);
    expect(rail.scrollTop).toBe(30);
  });
});
