import { describe, expect, it } from 'vitest';
import type { DayUsage, ModelUsage } from '../../lib/usageReport';
import { isoDay, metricValue, modelDistribution, trendCeiling, trendTimeline } from './usageChartData';

const model = (name: string, tokens: number, cost = 0, recordedCost = cost): ModelUsage =>
  ({ model: name, provider: 'relay', messages: 1, tokens, cost, recordedCost });
const day = (date: string, tokens: number): DayUsage => ({ date, tokens, messages: 1, cacheHitRate: 0, cost: 1, recordedCost: 2 });

describe('model distribution', () => {
  it('normalizes previously provider-split rows before ranking', () => {
    const rows = [
      { ...model(' OpenAI/GPT-6.1-sol ', 12), recordedCost: undefined },
      { ...model('gpt-6.1-sol', 3), provider: 'other', recordedCost: undefined },
      { ...model('qwen', 15), recordedCost: undefined },
    ] as unknown as ModelUsage[];
    const { slices, total } = modelDistribution(rows, 'tokens');
    expect(total).toBe(30);
    expect(slices.map(s => [s.name, s.value, s.percent])).toEqual([['gpt-6.1-sol', 15, 50], ['qwen', 15, 50]]);
  });
  it('assigns all long-tail usage (even a single seventh model) to Others and apportions exactly 100%', () => {
    const rows = Array.from({ length: 9 }, (_, i) => model('model' + i, 1));
    const ranked = modelDistribution(rows, 'tokens');
    expect(ranked.slices).toHaveLength(7);
    expect(ranked.slices.at(-1)).toMatchObject({ name: '其他 (Others)', value: 3, percent: 34, colorIndex: 6 });
    expect(ranked.slices.map(row => row.percent).reduce((a, b) => a + b, 0)).toBe(100);
    expect(modelDistribution(rows.slice(0, 7), 'tokens').slices.at(-1)?.key).toBe('others');
    expect(modelDistribution(rows.slice(0, 6), 'tokens').slices.some(s => s.key === 'others')).toBe(false);
  });
  it('folds untrimmed display variants even when both channels carry recorded dollars, keeping custom namespaces', () => {
    const rows = [model('gpt-6.1-sol', 28, 14), { ...model(' ＧＰＴ-6.1-SOL ', 9, 5), provider: 'second' },
      model('relay/model', 25), model('model', 38)];
    expect(modelDistribution(rows, 'tokens').slices.find(r => r.name === 'gpt-6.1-sol')).toMatchObject({ value: 37, percent: 37 });
    expect(modelDistribution(rows, 'cost').slices).toMatchObject([{ name: 'gpt-6.1-sol', value: 19, percent: 100 }]);
    expect(modelDistribution(rows, 'tokens').slices).toHaveLength(3);
  });
  it('ranks recorded dollars, including warm-only models; shared named slices keep their color', () => {
    const rows = [
      ...Array.from({ length: 7 }, (_, i) => model('model' + i, 70 - i, 1, i === 2 ? 5 : 1)),
      model('warm-only', 0, 0, 100),
    ];
    const tokens = modelDistribution(rows, 'tokens'), money = modelDistribution(rows, 'cost');
    expect(tokens.slices[0].name).toBe('model0');
    expect(money.slices[0]).toMatchObject({ name: 'warm-only', value: 100 });
    expect(money.total).toBe(111);
    expect(money.slices.reduce((a, b) => a + b.percent, 0)).toBe(100);
    for (const slice of money.slices) {
      const before = tokens.slices.find(s => s.key === slice.key);
      if (before) expect(slice.colorIndex).toBe(before.colorIndex);
    }
    expect(new Set(money.slices.map(row => row.colorIndex)).size).toBe(money.slices.length);
  });
  it('does not invent expenses for zero-dollar usage or discard explicit zero when fallback cost is nonzero', () => {
    const free = model('fixed', 30, 3, 0);
    expect(metricValue(free, 'cost')).toBe(0);
    expect(modelDistribution([free], 'cost')).toEqual({ total: 0, slices: [] });
    expect(metricValue({ tokens: 1, cost: .5 }, 'cost')).toBe(.5);
  });
});

describe('daily scale', () => {
  it('uses elapsed UTC days on the x-axis without allocating empty observations between distant days', () => {
    const { points, first, x, days, ticks } = trendTimeline([day('2026-01-01', 1), day('2025-01-01', 2), day('2025-01-02', 3)]);
    expect(points).toHaveLength(3); expect(days).toBe(366); expect(ticks).toHaveLength(5);
    expect(isoDay(first)).toBe('2025-01-01'); expect(x(points[1].day) - x(first)).toBeCloseTo(100 / 366);
    expect(isoDay(ticks.at(-1)!)).toBe('2026-01-01');
  });
  it('centers a single day, does not duplicate ticks and handles no observations', () => {
    const one = trendTimeline([day('2026-02-08', 2)]);
    expect(one.x(one.first)).toBe(50); expect(one.ticks).toEqual([one.first]);
    expect(trendTimeline([]).points).toHaveLength(0);
  });
  it('keeps readable quarters, whole-token ticks and fractional cost ticks', () => {
    expect(trendCeiling(1.76e9, 'tokens')).toBe(1.8e9);
    expect(trendCeiling(2, 'tokens')).toBe(4);
    expect(trendCeiling(.00018, 'cost')).toBeCloseTo(.00018, 5);
  });
});

