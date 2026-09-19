import { describe, expect, it } from 'vitest';
import { SMOOTH_JUMP_MAX_ITEMS, shouldSmoothScroll } from './listScrollPolicy';

describe('shouldSmoothScroll', () => {
  it('近距离跳转才走平滑滚动', () => {
    expect(shouldSmoothScroll(10, 10)).toBe(true);
    expect(shouldSmoothScroll(10, 10 + SMOOTH_JUMP_MAX_ITEMS)).toBe(true);
    expect(shouldSmoothScroll(10, 10 - SMOOTH_JUMP_MAX_ITEMS)).toBe(true);
  });

  it('大跨度跳转立刻落点，避免沿途挂载重型消息', () => {
    expect(shouldSmoothScroll(10, 10 + SMOOTH_JUMP_MAX_ITEMS + 1)).toBe(false);
    expect(shouldSmoothScroll(80, 0)).toBe(false);
    expect(shouldSmoothScroll(0, 40)).toBe(false);
  });
});
