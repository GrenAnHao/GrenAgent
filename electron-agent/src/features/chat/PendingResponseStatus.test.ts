import { describe, expect, it } from 'vitest';
import { formatPendingDuration } from './PendingResponseStatus';

describe('formatPendingDuration', () => {
  it('formats seconds, minutes, and hours the way the waiting clock reads', () => {
    expect(formatPendingDuration(15_000)).toBe('15秒');
    expect(formatPendingDuration(75_000)).toBe('1分15秒');
    expect(formatPendingDuration(3_661_000)).toBe('1小时01分01秒');
  });
});