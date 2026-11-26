import { useMemo, useState } from 'react';
import type { ModelUsage } from '../../lib/usageReport';
import { modelDistribution, type UsageMetric } from './usageChartData';
import { exactUsageTokens, formatUsageCost, formatUsageTokens } from './usageFormat';
import { UsageChartHint } from './UsageChartHint';

const palette = (i: number) => `var(--usage-series-${i})`;
const point = (turn: number, radius = 44.85) => {
  const angle = turn * Math.PI * 2;
  return [50 + radius * Math.sin(angle), 50 - radius * Math.cos(angle)].join(' ');
};
// Two arcs also draw a one-model, full-circle ring without a coincident SVG endpoint.
function arc(from: number, to: number) {
  return `M ${point(from)} A 44.85 44.85 0 0 1 ${point((from + to) / 2)} A 44.85 44.85 0 0 1 ${point(to)}`;
}

export function ModelUsageChart({ rows, metric }: { rows: ModelUsage[]; metric: UsageMetric }) {
  const { total, slices } = useMemo(() => modelDistribution(rows, metric), [rows, metric]);
  const [hover, setHover] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const current = slices.find(slice => slice.key === (hover ?? focus));
  const format = metric === 'cost' ? formatUsageCost : formatUsageTokens;
  const totalText = metric === 'cost' && total >= 1000 ? '$' + Math.round(total).toLocaleString('en-US') : format(total);
  if (!slices.length) return <div className="usage-chart-empty">{metric === 'cost' ? '所选范围没有非零费用' : '所选范围没有 Token'}</div>;
  let sum = 0;
  const segments = slices.map(slice => {
    const start = sum / total;
    sum += slice.value;
    return { ...slice, start, end: sum / total };
  });
  return <div className="usage-model" onPointerLeave={() => setHover(null)}>
    <div className="usage-donut">
      <svg viewBox="0 0 100 100" role="img" aria-label="模型占比圆环，明细见旁边图例"
        onPointerMove={e => setHover((e.target as SVGElement).getAttribute('data-usage-slice'))}
        onPointerLeave={() => setHover(null)}>
        {segments.map(s => <path key={s.key} data-usage-slice={s.key} d={arc(s.start, s.end)}
          fill="none" stroke={palette(s.colorIndex)} strokeWidth={9.8}/>)}
        {segments.length > 1 && segments.map(s => <path key={s.key} aria-hidden="true"
          d={`M ${point(s.start, 39.95)} L ${point(s.start, 49.75)}`} stroke="var(--gren-bg-1)" strokeWidth={0.9} pointerEvents="none"/>)}
      </svg>
      <div className="usage-donut-center" data-usage-active-model={current?.name}>
        {current ? <>
          <span className="usage-center-name">{current.name}</span>
          <strong>{format(current.value)}</strong><span>{current.percent}%</span>
        </> : <>
          <strong data-usage-donut-total="">{totalText}</strong>
          <span>{metric === 'tokens' ? '总 Token' : rows.some(row => row.recordedCost !== undefined) ? '已记录费用' : '助手费用'}</span>
        </>}
      </div>
    </div>
    <ul className="usage-model-legend" aria-label="模型用量明细" onPointerLeave={() => setHover(null)}>
      {slices.map(s => <li key={s.key} tabIndex={0} data-usage-model={s.name} data-active={current?.key === s.key || undefined}
        onPointerEnter={() => setHover(s.key)} onFocus={() => setFocus(s.key)} onBlur={() => setFocus(null)}>
        <i aria-hidden="true" style={{ background: palette(s.colorIndex) }}/>
        <span className="usage-model-name">{s.name}</span>
        <UsageChartHint title={s.name + ' · ' + (metric === 'tokens' ? exactUsageTokens(s.value) : format(s.value))}>
          <span className="usage-model-value">{format(s.value)}</span>
        </UsageChartHint>
        <span className="usage-model-share" data-usage-percent="">{s.percent}%</span>
      </li>)}
    </ul>
  </div>;
}
