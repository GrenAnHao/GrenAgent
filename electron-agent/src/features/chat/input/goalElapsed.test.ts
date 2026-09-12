import { describe, expect, it } from 'vitest';
import { formatGoalElapsed } from './goalElapsed';

describe('formatGoalElapsed', () => {
  const now = Date.parse('2026-09-13T00:01:00.000Z');
  it('uses 1s below one second', () => {
    expect(formatGoalElapsed('2026-09-13T00:00:59.500Z', now)).toBe('1s');
  });
  it('uses seconds then minutes then hours', () => {
    expect(formatGoalElapsed('2026-09-13T00:00:10.000Z', now)).toBe('50s');
    expect(formatGoalElapsed('2026-09-13T00:00:00.000Z', now)).toBe('1m');
    expect(formatGoalElapsed('2026-09-12T22:01:00.000Z', now)).toBe('2h');
  });
});
