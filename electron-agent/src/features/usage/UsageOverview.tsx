import type { ReactNode } from 'react';
import { Tooltip } from 'antd';
import type { UsageReport } from '../../lib/usageReport';
import { exactUsageTokens, formatUsageCost, formatUsageCount, formatUsageRate, formatUsageTokens } from './usageFormat';
import styles from './UsagePanel.module.css';

export function UsageSources({ report }: { report: UsageReport }) {
  const costs = report.recordedCost;
  return <div className={styles.sources} data-testid="usage-provenance-summary" aria-label="费用来源">
    <span className={styles.sourceGroup}>
      <span>助手费用 <b>{formatUsageCost(costs?.assistantCost ?? report.totals.cost)}</b></span>
      {costs && <span>预热费用 <b>{formatUsageCost(costs.warmingCost)}</b></span>}
    </span>
    {costs ? <span className={styles.sourceGroup}>
      <span>供应商报告 <b>{formatUsageCost(costs.sourceBreakdown.provider)}</b></span>
      <span>目录估算 <b>{formatUsageCost(costs.sourceBreakdown.catalog)}</b></span>
      <span>来源未知 <b>{formatUsageCost(costs.sourceBreakdown.unknown)}</b></span>
    </span> : <span>旧报表：费用来源未知，预热费用未提供</span>}
  </div>;
}

function Kpi({ label, value, detail, help }: {label: string; value: ReactNode; detail: string; help?: string}) {
  return <div className={styles.kpi}>
    <dt>{label}</dt><dd>{value}</dd>
    <div className={styles.kpiDetail} data-testid="usage-kpi-detail" title={help || detail}>{detail}</div>
  </div>;
}

export function UsageKpis({ report }: { report: UsageReport }) {
  const t = report.totals;
  const c = report.recordedCost;
  const parts = [t.input + t.cacheWrite, t.cacheRead, t.output];
  const total = parts.reduce((a,b) => a + b, 0);
  const split = parts.map(n => total ? formatUsageRate(n / total) : '—');
  const precise = exactUsageTokens(t.totalTokens);
  return <dl className={styles.kpis} data-testid="usage-kpis">
    <Kpi label="总 Token" value={<Tooltip title={precise} trigger={['hover','focus']}>
      <span tabIndex={0} aria-label={precise} data-testid="usage-token-total">{formatUsageTokens(t.totalTokens)}</span>
    </Tooltip>} detail={`输入 ${split[0]} · 命中 ${split[1]} · 输出 ${split[2]}`}
      help={`输入（含缓存写入）${exactUsageTokens(parts[0])}；缓存命中 ${exactUsageTokens(t.cacheRead)}；输出 ${exactUsageTokens(t.output)}`}/>
    <Kpi label="已记录费用" value={formatUsageCost(c?.totalCost ?? t.cost)}
      detail={c ? (c.totalCost ? `目录估算占比 ${formatUsageRate(c.sourceBreakdown.catalog / c.totalCost)}` : '此范围无已记录费用') : '费用来源未知'}/>
    <Kpi label="会话数" value={formatUsageCount(t.sessions)}
      detail={t.sessions ? `平均 ${(t.messages / t.sessions).toLocaleString('en-US', {maximumFractionDigits: 1})} 次调用 / 会话` : '此范围无助手会话'}/>
    <Kpi label="缓存命中率" value={t.input + t.cacheRead ? formatUsageRate(t.cacheHitRate) : '—'}
      detail={`命中 ${formatUsageTokens(t.cacheRead)} Token`} help={`缓存读取 ${exactUsageTokens(t.cacheRead)}；分母为未缓存输入与缓存读取之和。`}/>
    <Kpi label="助手消息" value={formatUsageCount(t.messages)}
      detail={t.messages ? `平均 ${formatUsageTokens(Math.round(t.totalTokens / t.messages))} Token / 条` : '此范围无助手调用'}/>
  </dl>;
}
