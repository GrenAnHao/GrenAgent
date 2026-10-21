import { describe, expect, it } from 'vitest';
import { badgeText, drawBadgeOverlay } from './badgeOverlay';

describe('badgeOverlay', () => {
  it('caps the badge text at 9+', () => {
    expect(badgeText(1)).toBe('1');
    expect(badgeText(9)).toBe('9');
    expect(badgeText(10)).toBe('9+');
    expect(badgeText(42)).toBe('9+');
  });

  it('draws nothing for zero or without a 2d context', () => {
    expect(drawBadgeOverlay(0)).toBeUndefined();
    expect(drawBadgeOverlay(-1)).toBeUndefined();
    // jsdom 的 canvas 没有 2d context
    expect(drawBadgeOverlay(3)).toBeUndefined();
  });
});
