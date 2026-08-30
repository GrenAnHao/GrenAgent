import { describe, it, expect } from 'vitest';
import { buildContextBreakdown, mapSessionStats, type SessionStats } from './sessionStats';

const base: SessionStats = {
  sessionId: 'sid-1',
  sessionFile: '/tmp/s.jsonl',
  userMessages: 2,
  assistantMessages: 3,
  toolCalls: 1,
  toolResults: 1,
  totalMessages: 6,
  tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 },
  cost: 0.012,
  contextUsage: { tokens: 50000, contextWindow: 200000, percent: 25 },
};

describe('mapSessionStats', () => {
  it('maps known context with normal status', () => {
    const r = mapSessionStats(base);
    expect(r.contextKnown).toBe(true);
    expect(r.contextUsed).toBe(50000);
    expect(r.contextLimit).toBe(200000);
    expect(r.contextPercent).toBe(25);
    expect(r.contextStatus).toBe('normal');
  });

  it('returns unknown when tokens is null', () => {
    const r = mapSessionStats({
      ...base,
      contextUsage: { tokens: null, contextWindow: 200000, percent: null },
    });
    expect(r.contextKnown).toBe(false);
    expect(r.contextUsed).toBeNull();
    expect(r.contextStatus).toBe('unknown');
  });

  it('returns warning at 70%', () => {
    const r = mapSessionStats({
      ...base,
      contextUsage: { tokens: 140000, contextWindow: 200000, percent: 70 },
    });
    expect(r.contextStatus).toBe('warning');
  });

  it('returns danger at 90%', () => {
    const r = mapSessionStats({
      ...base,
      contextUsage: { tokens: 180000, contextWindow: 200000, percent: 90 },
    });
    expect(r.contextStatus).toBe('danger');
  });

  it('handles missing contextUsage', () => {
    const r = mapSessionStats({ ...base, contextUsage: undefined });
    expect(r.contextKnown).toBe(false);
    expect(r.contextLimit).toBe(0);
  });
});

describe('buildContextBreakdown', () => {
  it('includes context used and free segments', () => {
    const stats = mapSessionStats(base);
    const items = buildContextBreakdown(stats);
    const used = items.find((i) => i.id === 'used');
    const free = items.find((i) => i.id === 'free');
    expect(used?.tokens).toBe(50000);
    expect(free?.tokens).toBe(150000);
    expect(used?.group).toBe('context');
  });
});
