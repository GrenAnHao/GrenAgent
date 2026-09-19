import { describe, expect, it } from 'vitest';
import { formatClosedAgo } from './formatClosedAgo';

describe('formatClosedAgo', () => {
  const now = Date.parse('2026-09-15T12:00:00Z');

  it('uses Codex-style buckets', () => {
    expect(formatClosedAgo(now - 10_000, now)).toBe('刚刚');
    expect(formatClosedAgo(now - 59_000, now)).toBe('刚刚');
    expect(formatClosedAgo(now - 60_000, now)).toBe('1分');
    expect(formatClosedAgo(now - 3 * 60_000, now)).toBe('3分');
    expect(formatClosedAgo(now - 2 * 3600_000, now)).toBe('2小时');
    expect(formatClosedAgo(now - 3 * 86_400_000, now)).toBe('3天');
  });
});
