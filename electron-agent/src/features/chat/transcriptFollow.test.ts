import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOLLOW_THRESHOLD, SAMPLE_INTERVAL_MS, TranscriptFollow } from './transcriptFollow';

/** jsdom 没有布局：用可写的 scrollTop 和固定的 scrollHeight / clientHeight 模拟滚动容器。 */
function scroller(scrollHeight: number, clientHeight = 600) {
  const el = document.createElement('div');
  let top = 0;
  let height = scrollHeight;
  Object.defineProperties(el, {
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = Math.max(0, Math.min(height - clientHeight, v));
      },
    },
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, value: clientHeight },
  });
  return {
    el,
    grow: (px: number) => {
      height += px;
    },
    floor: () => height - clientHeight,
  };
}

describe('TranscriptFollow', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const changes: boolean[] = [];
    const follow = new TranscriptFollow((v) => changes.push(v));
    const s = scroller(5000);
    follow.toBottom(s.el);
    return { follow, changes, ...s };
  }

  it('follows content growth while no reader movement is pending', () => {
    const { follow, el, grow, floor } = setup();
    grow(300);
    follow.reconcile(el);
    expect(el.scrollTop).toBe(floor());
  });

  it('treats its own write echo and downward jumps as programmatic', () => {
    const { follow, el, grow, floor } = setup();
    follow.onScroll(el);
    grow(200);
    el.scrollTop += 150; // virtua 跳变补偿：往下，没到底
    follow.onScroll(el);
    expect(follow.pending).toBe(false);
    expect(el.scrollTop).toBe(floor());
    expect(follow.active).toBe(true);
  });

  it('keeps following when the browser clamps after content shrinks', () => {
    const { follow, el, changes } = setup();
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 4000 });
    el.scrollTop = el.scrollTop; // 钳制到新的底部
    follow.onScroll(el);
    expect(follow.pending).toBe(false);
    expect(changes).toEqual([]);
  });

  it('holds a reader move pending and does not pull it back on growth', () => {
    const { follow, el, grow, floor } = setup();
    el.scrollTop = floor() - 10;
    follow.onScroll(el);
    expect(follow.pending).toBe(true);
    const top = el.scrollTop;
    grow(400);
    follow.reconcile(el);
    expect(el.scrollTop).toBe(top);
  });

  it('releases follow when the sampled position is beyond the threshold', () => {
    const { follow, el, grow, floor, changes } = setup();
    el.scrollTop = floor() - 10;
    follow.onScroll(el);
    grow(400); // 待采样期间内容长高：离底变大
    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS);
    expect(follow.active).toBe(false);
    expect(changes).toEqual([false]);
  });

  it('resumes follow when the reader stops within the threshold at scrollend', () => {
    const { follow, el, floor } = setup();
    el.scrollTop = floor() - 200;
    follow.onScroll(el);
    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS);
    expect(follow.active).toBe(false);
    el.scrollTop = floor() - FOLLOW_THRESHOLD;
    follow.onScroll(el);
    follow.onScrollEnd(el);
    expect(follow.active).toBe(true);
    expect(el.scrollTop).toBe(floor());
  });

  it('resumes follow immediately when the reader reaches the floor', () => {
    const { follow, el, floor } = setup();
    el.scrollTop = floor() - 300;
    follow.onScroll(el);
    follow.onScrollEnd(el);
    expect(follow.active).toBe(false);
    el.scrollTop = floor();
    follow.onScroll(el);
    expect(follow.active).toBe(true);
    expect(follow.pending).toBe(false);
  });

  it('acknowledged programmatic scrolls do not count as reader movement', () => {
    const { follow, el, floor } = setup();
    el.scrollTop = floor() - 300;
    follow.onScroll(el);
    follow.onScrollEnd(el);
    el.scrollTop = 1000; // resize 锚点恢复
    follow.acknowledge(el);
    follow.onScroll(el);
    expect(follow.pending).toBe(false);
    expect(follow.active).toBe(false);
  });
});
