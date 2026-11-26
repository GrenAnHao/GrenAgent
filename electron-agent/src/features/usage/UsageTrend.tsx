import { createPortal } from 'react-dom';
import { useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { DayUsage } from '../../lib/usageReport';
import { formatUsageCost, formatUsageCount, formatUsageRate, formatUsageTokens } from './usageFormat';
import { isoDay, metricValue, trendCeiling, trendTimeline, type UsageMetric } from './usageChartData';
import { placeTrendTip, weekdayOf } from './trendInspection';



function axisLabel(value: number, metric: UsageMetric) {
  if (metric === 'tokens') return formatUsageTokens(value, 'axis');
  if (value >= 1000) return '$' + formatUsageTokens(value, 'axis');
  return '$' + Number(value.toPrecision(3));
}

function TrendTip({ day, row, id, barRef }: { day: number; row: DayUsage; id: string; barRef: RefObject<HTMLSpanElement | null> }) {
  const tipRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const tip = tipRef.current!, bar = barRef.current!;
    const plot = bar.parentElement!, card = plot.closest('section')!;
    function place() {
      const rect = card.getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      const pos = placeTrendTip({left:rect.left+2, right:rect.right-2}, b, tip.offsetWidth,
        Array.from(plot.querySelectorAll('.usage-trend-bar'), el => el.getBoundingClientRect()));
      tip.style.left = pos.left + 'px';
      tip.style.top = pos.bottom + 'px';
      tip.style.setProperty('--anchor', pos.anchor + 'px');
      tip.style.setProperty('--stem', pos.stem + 'px');
    }
    place();
    const observer = new ResizeObserver(place);
    observer.observe(plot); observer.observe(tip); observer.observe(bar);
    window.addEventListener('scroll', place, true);
    return () => { observer.disconnect(); window.removeEventListener('scroll', place, true); };
  }, [day, row, barRef]);
  return createPortal(<div ref={tipRef} id={id} role="tooltip" className="usage-trend-tip" data-usage-trend-tip="">
    <strong>{row.date} {weekdayOf(row.date)}</strong>
    <dl>
      <dt>总 Token</dt><dd>{row.tokens < 1000 ? formatUsageCount(row.tokens) :
        `${formatUsageTokens(row.tokens, 'detail')} (${formatUsageCount(row.tokens)})`}</dd>
      <dt>{row.recordedCost === undefined ? '助手费用' : '已记录费用'}</dt><dd>{formatUsageCost(metricValue(row, 'cost'))}</dd>
      <dt>助手调用</dt><dd>{row.messages === undefined ? '—' : formatUsageCount(row.messages) + ' 次'}</dd>
      <dt>缓存命中率</dt><dd>{row.cacheHitRate === undefined ? '—' : formatUsageRate(row.cacheHitRate)}</dd>
    </dl>
  </div>, document.body);
}

export function UsageTrend({ rows, metric }: { rows: DayUsage[]; metric: UsageMetric }) {
  const timeline = useMemo(() => trendTimeline(rows), [rows]);
  const [activeDay, setActiveDay] = useState<number | null>(null);
  const activeBar = useRef<HTMLSpanElement>(null);
  const tipId = useId();
  const { first, days, points, x, byDay, ticks } = timeline;
  const active = activeDay === null ? undefined : byDay.get(activeDay);
  const ceiling = trendCeiling(points.reduce((n, p) => Math.max(n, metricValue(p.row, metric)), 0), metric);
  if (!points.length) return <div className="usage-chart-empty">所选范围没有用量记录</div>;
  const includesYears = isoDay(first).slice(0, 4) !== isoDay(first + days - 1).slice(0, 4);
  return <div className="usage-trend">
    <div className="usage-trend-scale" aria-hidden="true">
      {[4, 3, 2, 1, 0].map(i => <span key={i} style={{ top: (100 - 25 * i) + '%' }}>{axisLabel(ceiling * i / 4, metric)}</span>)}
    </div>
    <div className="usage-trend-plot" role="group" aria-label="每日用量，使用左右方向键查看各日明细" tabIndex={0}
      aria-describedby={active ? tipId : undefined}
      onFocus={() => setActiveDay(points.at(-1)!.day)} onBlur={() => setActiveDay(null)}
      onPointerMove={event => {
        const rect = event.currentTarget.getBoundingClientRect();
        const slot = Math.max(0, Math.min(days - 1, Math.floor((event.clientX - rect.left) / rect.width * days)));
        setActiveDay(first + slot);
      }} onPointerLeave={() => setActiveDay(null)}
      onKeyDown={event => {
        const i = points.findIndex(p => p.day === activeDay);
        if (event.key === 'Escape') { setActiveDay(null); return; }
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 :
          Math.max(0, Math.min(points.length - 1, i + (event.key === 'ArrowLeft' ? -1 : 1)));
        setActiveDay(points[next].day);
      }}>
      <div className="usage-trend-grid" aria-hidden="true">{[0, 1, 2, 3, 4].map(i => <i key={i} />)}</div>
      {active && activeDay !== null && <i className="usage-trend-band" aria-hidden="true"
        style={{ left: (activeDay - first) / days * 100 + '%', width: 100 / days + '%' }} />}
      {points.map(({ day, row }) => <span key={day} ref={day === activeDay ? activeBar : undefined}
        aria-hidden="true" data-usage-day={row.date} className="usage-trend-bar" data-active={day === activeDay || undefined}
        style={{ left: x(day) + '%', width: `clamp(1px, ${74 / days}%, 42px)`, height: metricValue(row, metric) / ceiling * 100 + '%' }} />)}
    </div>
    <div className="usage-trend-dates" data-years={includesYears || undefined} aria-hidden="true">{ticks.map((day, i) => {
      const date = isoDay(day);
      const label = includesYears ? date : date.slice(5).replace('-', '/');
      return <span key={day} data-edge={ticks.length === 1 ? undefined : i === 0 ? 'first' : i === ticks.length - 1 ? 'last' : undefined}
        style={{ left: `clamp(var(--usage-tick-half), ${x(day)}%, calc(100% - var(--usage-tick-half)))` }}>{label}</span>;
    })}</div>
    {active && activeDay !== null && <TrendTip day={activeDay} row={active} id={tipId} barRef={activeBar}/>}
  </div>;
}
