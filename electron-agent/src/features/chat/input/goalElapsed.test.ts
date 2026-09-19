import { describe, expect, it } from 'vitest';
import { formatGoalElapsed } from './goalElapsed';

describe('formatGoalElapsed', () => {
  const now = Date.parse('2026-09-13T00:02:00.000Z');

  it('uses 1s below one second', () => {
    expect(formatGoalElapsed(0, '2026-09-13T00:01:59.500Z', now)).toBe('1s');
  });

  it('adds the live segment to accumulated running time', () => {
    expect(formatGoalElapsed(10_000, '2026-09-13T00:01:10.000Z', now)).toBe('1m');
    expect(formatGoalElapsed(0, '2026-09-13T00:00:00.000Z', now)).toBe('2m');
    expect(formatGoalElapsed(7_200_000, undefined, now)).toBe('2h');
  });

  it('freezes at ranMs when the run is not live', () => {
    expect(formatGoalElapsed(50_000, undefined, now)).toBe('50s');
    expect(formatGoalElapsed(50_000, 'not-a-date', now)).toBe('50s');
  });
});
