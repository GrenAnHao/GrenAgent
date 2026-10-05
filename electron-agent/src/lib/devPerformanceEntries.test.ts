import { afterEach, describe, expect, it, vi } from 'vitest';
import { MEASURE_CLEAR_INTERVAL_MS, startClearingDevMeasures } from './devPerformanceEntries';

afterEach(() => {
  vi.useRealTimers();
});

describe('startClearingDevMeasures', () => {
  it('clears measure entries on an interval until stopped', () => {
    vi.useFakeTimers();
    const perf = { clearMeasures: vi.fn() };
    const stop = startClearingDevMeasures(perf);
    vi.advanceTimersByTime(MEASURE_CLEAR_INTERVAL_MS * 3);
    expect(perf.clearMeasures).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(MEASURE_CLEAR_INTERVAL_MS * 3);
    expect(perf.clearMeasures).toHaveBeenCalledTimes(3);
  });

  it('is a no-op without clearMeasures', () => {
    expect(() => startClearingDevMeasures({} as Pick<Performance, 'clearMeasures'>)()).not.toThrow();
  });
});
