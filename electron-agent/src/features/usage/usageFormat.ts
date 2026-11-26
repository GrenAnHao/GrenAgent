const count = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const dollars = (digits: number) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits,
});
const cents = dollars(2);
const subDollar = dollars(4);

export const formatUsageCount = (value: number) => count.format(value);
export const exactUsageTokens = (value: number) => `${formatUsageCount(value)} tokens`;
export const formatUsageCost = (value: number) => (Math.abs(value) < 1 ? subDollar : cents).format(value);
/** Table amounts use cents except for nonzero sub-dime charges. */
export const formatTableCost = (value: number) => (value !== 0 && Math.abs(value) < 0.10 ? subDollar : cents).format(value);
const percent = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
export const formatUsageRate = (ratio: number) => {
  if (ratio > 0 && ratio < 0.001) return '<0.1%';
  if (ratio > 0.999 && ratio < 1) return '>99.9%';
  return percent.format(ratio);
};

/** Totals are three-significant-digit estimates. Axis labels omit padding; tooltips use the original integer. */
export function formatUsageTokens(value: number, mode: 'value' | 'axis' | 'detail' = 'value'): string {
  if (Math.abs(value) < 1_000) return formatUsageCount(value);
  const units = ['', 'K', 'M', 'B'];
  let unit = Math.abs(value) >= 1e9 ? 3 : Math.abs(value) >= 1e6 ? 2 : 1;
  const scaled = value / 1000 ** unit;
  let n = Number(mode === 'detail' ? scaled.toFixed(2) : scaled.toPrecision(3));
  if (Math.abs(n) >= 1000 && unit < 3) { n /= 1000; unit++; }
  return (mode === 'value' && unit === 3 ? n.toFixed(2) : String(n)) + units[unit];
}
