import { expect, it } from 'vitest';
import { exactUsageTokens, formatTableCost, formatUsageCost, formatUsageCount, formatUsageRate, formatUsageTokens } from './usageFormat';

it('scales the overview independently of its precise tooltip and the axis', () => {
  expect(formatUsageTokens(26_992_500_000)).toBe('27.00B');
  expect(exactUsageTokens(26_992_500_000)).toBe('26,992,500,000 tokens');
  expect(formatUsageTokens(717_583_069, 'detail')).toBe('717.58M');
  expect([1.8e9, 1.35e9, 9e8, 4.5e8, 0].map(n => formatUsageTokens(n, 'axis')))
    .toEqual(['1.8B', '1.35B', '900M', '450M', '0']);
  expect([999, 1_000, 1e6, 999_999_999, 1e9].map(n => formatUsageTokens(n)))
    .toEqual(['999', '1K', '1M', '1.00B', '1.00B']);
});
it('groups counts and dollars without hiding small recorded charges', () => {
  expect(formatUsageCount(111_995)).toBe('111,995');
  expect(formatUsageCount(1463)).toBe('1,463');
  expect(formatUsageCost(1882.12)).toBe('$1,882.12');
  expect(formatUsageCost(0.0012)).toBe('$0.0012');
  expect([9.25, 0.10, 0.0123, 0].map(formatTableCost)).toEqual(['$9.25','$0.10','$0.0123','$0.00']);
  expect(formatUsageRate(3 / 1882)).toBe('0.2%');
  expect(formatUsageRate(0.00003)).toBe('<0.1%');
  expect(formatUsageRate(1)).toBe('100%');
});
