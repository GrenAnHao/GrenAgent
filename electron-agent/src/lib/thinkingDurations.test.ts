import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveThinkingDuration,
  getThinkingDuration,
  clearThinkingDurationsForTest,
} from './thinkingDurations';

describe('thinkingDurations', () => {
  beforeEach(() => {
    clearThinkingDurationsForTest();
  });

  it('保存后可按 timestamp 取回', () => {
    saveThinkingDuration(1700000000001, 2300);
    expect(getThinkingDuration(1700000000001)).toBe(2300);
  });

  it('无记录 / 非法 key 返回 undefined', () => {
    expect(getThinkingDuration(123)).toBeUndefined();
    expect(getThinkingDuration(undefined)).toBeUndefined();
    expect(getThinkingDuration(Number.NaN)).toBeUndefined();
  });

  it('忽略非法时长（<=0 / NaN）', () => {
    saveThinkingDuration(42, 0);
    saveThinkingDuration(43, -5);
    saveThinkingDuration(44, Number.NaN);
    expect(getThinkingDuration(42)).toBeUndefined();
    expect(getThinkingDuration(43)).toBeUndefined();
    expect(getThinkingDuration(44)).toBeUndefined();
  });

  it('超出容量时按 timestamp 淘汰最旧条目', () => {
    for (let i = 0; i < 1001; i++) {
      saveThinkingDuration(1000 + i, 100 + i);
    }
    // 最旧的 timestamp=1000 被淘汰，最新的保留
    expect(getThinkingDuration(1000)).toBeUndefined();
    expect(getThinkingDuration(2000)).toBe(1100);
  });
});
