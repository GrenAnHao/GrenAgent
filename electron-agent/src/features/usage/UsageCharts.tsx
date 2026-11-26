import { ModelUsageChart } from './ModelUsageChart';
import { useMemo, useState, type ReactNode } from 'react';
import { cleanUsageTitle, type ProjectUsage, type UsageReport } from '../../lib/usageReport';
import { exactUsageTokens, formatTableCost, formatUsageTokens } from './usageFormat';
import { metricValue, type UsageMetric } from './usageChartData';
import { UsageTrend } from './UsageTrend';
import { UsageChartHint } from './UsageChartHint';
import './UsageCharts.css';

type Chart = 'trend' | 'model' | 'project';
interface ChartState {
  metrics: Record<Chart, UsageMetric>;
  onMetricChange: (chart: Chart, metric: UsageMetric) => void;
}

export function useUsageChartMetrics(): ChartState {
  const [metrics, setMetrics] = useState<Record<Chart, UsageMetric>>({ trend: 'tokens', model: 'tokens', project: 'tokens' });
  return { metrics, onMetricChange: (chart, metric) => setMetrics(prev => ({ ...prev, [chart]: metric })) };
}

function ChartCard({ title, metric, onChange, children }: {
  title: string; metric: UsageMetric; onChange: (metric: UsageMetric) => void; children: ReactNode;
}) {
  return <section className="usage-chart-card" aria-label={title}>
    <header className="usage-chart-head">
      <h2>{title}</h2>
      <div className="usage-metric-toggle" role="group" aria-label={title + '指标'}>
        {(['tokens', 'cost'] as const).map(unit => <button type="button" key={unit}
          aria-pressed={metric === unit} onClick={() => onChange(unit)}>{unit === 'tokens' ? 'Token' : '费用 ($)'}</button>)}
      </div>
    </header>
    {children}
  </section>;
}

const projectName = (row: ProjectUsage) => cleanUsageTitle(row.name) || row.cwd?.split(/[\\/]/).filter(Boolean).pop() || '未归属会话 (全局对话)';

function ProjectChart({ rows, metric }: { rows: ProjectUsage[]; metric: UsageMetric }) {
  const ranked = useMemo(() => rows.filter(row => row.tokens > 0 || (metric === 'cost' && metricValue(row, 'cost') !== 0))
    .sort((a, b) => metricValue(b, metric) - metricValue(a, metric) ||
    projectName(a).localeCompare(projectName(b))), [rows, metric]);
  const names = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) { const name = projectName(row); counts.set(name, (counts.get(name) ?? 0) + 1); }
    return counts;
  }, [rows]);
  if (!ranked.length) return <div className="usage-chart-empty">{metric === 'tokens' && rows.some(r => metricValue(r, 'cost') !== 0)
    ? '仅有费用记录，可切换至费用查看' : '所选范围没有项目用量'}</div>;
  const max = metricValue(ranked[0], metric);
  return <div className="usage-project-wrap">
    <table className="usage-project-table" style={{'--amount-width': (2 + ranked.reduce((n,r)=>Math.max(n,formatTableCost(metricValue(r,'cost')).length),8))+'ch'} as React.CSSProperties}>
      <thead><tr><th scope="col" colSpan={2}>项目</th><th scope="col" aria-sort={metric === 'tokens' ? 'descending' : undefined}>Token</th>
        <th scope="col" aria-sort={metric === 'cost' ? 'descending' : undefined}>费用 ($)</th></tr></thead>
      <tbody>{ranked.map(row => {
        const name = projectName(row), value = metricValue(row, metric);
        return <tr key={row.projectId ?? row.cwd} data-usage-project={row.projectId ?? row.cwd}>
          <th scope="row"><UsageChartHint title={row.cwd || name}><span>{(names.get(name) ?? 0) > 1 && row.cwd ? row.cwd : name}</span></UsageChartHint></th>
          <td className="usage-project-bar-cell"><i className="usage-project-bar" aria-hidden="true"
            style={{ width: (max ? 100 * value / max : 0) + '%' }} /></td>
          <td><UsageChartHint title={exactUsageTokens(row.tokens)}><span>{formatUsageTokens(row.tokens)}</span></UsageChartHint></td>
          <td data-zero={metricValue(row, 'cost') === 0 || undefined}>{formatTableCost(metricValue(row, 'cost'))}</td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}

export function UsageCharts({ report, metrics, onMetricChange }: { report: UsageReport } & ChartState) {
  // A fixed-range report pads missing local dates. Seven empty buckets are not seven observations.
  const hasActivity = report.totals.messages > 0 || (report.warmingTotals?.messages ?? 0) > 0;
  return <div className="usage-charts">
    <ChartCard title="每日趋势" metric={metrics.trend} onChange={m => onMetricChange('trend', m)}>
      <UsageTrend rows={hasActivity ? report.byDay : []} metric={metrics.trend} />
    </ChartCard>
    <div className="usage-chart-pair">
      <ChartCard title="按模型占比" metric={metrics.model} onChange={m => onMetricChange('model', m)}>
        <ModelUsageChart rows={report.byModel} metric={metrics.model} />
      </ChartCard>
      <ChartCard title="按项目对比" metric={metrics.project} onChange={m => onMetricChange('project', m)}>
        <ProjectChart rows={report.byProject} metric={metrics.project} />
      </ChartCard>
    </div>
  </div>;
}

