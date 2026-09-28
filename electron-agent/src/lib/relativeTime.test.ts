import { describe, expect, it } from 'vitest';
import { formatRelative } from './relativeTime';

describe('formatRelative', () => {
  const now = 1_000_000_000;
  it.each([
    [now - 5_000, '刚刚'],
    [now - 3 * 60_000, '3分钟前'],
    [now - 2 * 3_600_000, '2小时前'],
    [now - 3 * 86_400_000, '3天前'],
    [now + 60_000, '刚刚'],
  ])('formats %d', (ms, expected) => {
    expect(formatRelative(ms, now)).toBe(expected);
  });
});
