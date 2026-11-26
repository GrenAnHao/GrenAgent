import { standardUsageModel, type DayUsage, type ModelUsage } from '../../lib/usageReport';

export type UsageMetric = 'tokens' | 'cost';
type Amount = { tokens: number; cost: number; recordedCost?: number };

export const metricValue = (row: Amount, metric: UsageMetric) =>
  metric === 'tokens' ? row.tokens : row.recordedCost ?? row.cost;

const topCount = 6;

function rankedModels(rows: ModelUsage[], metric: UsageMetric) {
  const amounts = new Map<string, { name: string; value: number }>();
  for (const row of rows) {
    // The current report already resolves aliases; only legacy provider-split rows need renormalizing.
    const name = row.recordedCost === undefined ? standardUsageModel(row.provider, row.model) : row.model.trim() || '未知模型';
    const key = name.normalize('NFKC').toLowerCase();
    const found = amounts.get(key);
    const value = metricValue(row, metric);
    if (found) found.value += value;
    else amounts.set(key, { name, value });
  }
  return [...amounts.values()].filter(row => row.value > 0)
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
}

/** The six named slices and the actual remainder are rounded together (largest remainders first). */
export function modelDistribution(rows: ModelUsage[], metric: UsageMetric) {
  const tokens = rankedModels(rows, 'tokens');
  const ranked = metric === 'tokens' ? tokens : rankedModels(rows, 'cost');
  const head = ranked.slice(0, topCount);
  const tail = ranked.slice(topCount);
  // A model present in both top sixes keeps its color when switching units.
  const tokenColors = new Map(tokens.slice(0, topCount).map((row, index) => [row.name, index]));
  const used = new Set(head.map(row => tokenColors.get(row.name)));
  const spare = Array.from({ length: topCount }, (_, i) => i).filter(i => !used.has(i));
  const slices = head.map(row => ({ ...row, key: 'model:' + row.name, colorIndex: tokenColors.get(row.name) ?? spare.shift()! }));
  if (tail.length) slices.push({
    name: '其他 (Others)', key: 'others', value: tail.reduce((n, row) => n + row.value, 0), colorIndex: topCount,
  });
  const total = slices.reduce((n, row) => n + row.value, 0);
  const exact = slices.map(row => (row.value / total) * 100);
  const percent = exact.map(n => Math.floor(n));
  const remaining = 100 - percent.reduce((n, value) => n + value, 0);
  const remainders = exact.map((value, i) => ({ i, remainder: value - percent[i] }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  for (const { i } of remainders.slice(0, remaining)) percent[i]++;
  return { total, slices: slices.map((row, i) => ({ ...row, percent: percent[i] })) };
}

const dayMillis = 86_400_000;
export const utcDayIndex = (date: string) => Math.floor(Date.parse(date + 'T00:00:00Z') / dayMillis);
export function trendTimeline(rows: DayUsage[]) {
  const points = rows.map(row => ({ row, day: utcDayIndex(row.date) })).filter(p => Number.isFinite(p.day))
    .sort((a, b) => a.day - b.day);
  const first = points[0]?.day ?? 0;
  const days = (points.at(-1)?.day ?? first) - first + 1;
  const x = (day: number) => (day - first + 0.5) / days * 100;
  const steps = Math.min(5, days);
  const ticks = Array.from({ length: steps }, (_, i) =>
    first + (steps === 1 ? 0 : Math.round(i * (days - 1) / (steps - 1))));
  return { points, first, days, x, ticks, byDay: new Map(points.map(p => [p.day, p.row])) };
}

export const isoDay = (day: number) => new Date(day * dayMillis).toISOString().slice(0, 10);
export function trendCeiling(peak: number, metric: UsageMetric) {
  if (peak <= 0) return metric === 'tokens' ? 4 : 1;
  const rawStep = peak / 4;
  const unit = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 1.25, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7.5, 9, 10]
    .find(n => n * unit >= rawStep) ?? 10;
  return 4 * (metric === 'tokens' ? Math.ceil(unit * step) : unit * step);
}

