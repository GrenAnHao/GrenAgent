import { describe, expect, it } from 'vitest';
import { queueSummaryLabel } from './queueSummary';

describe('queueSummaryLabel', () => {
  it('带上条数和第一条原文', () => {
    expect(queueSummaryLabel([{ text: '  先改测试  ' }, { text: '第二条' }])).toBe('排队 · 2 · 先改测试');
  });

  it('第一条没有文字时只显示条数', () => {
    expect(queueSummaryLabel([{ text: '   ' }])).toBe('排队 · 1');
  });

  it('空队列返回空字符串', () => {
    expect(queueSummaryLabel([])).toBe('');
  });
});
