import { useEffect, useState } from 'react';
import { Segmented, Select, Tooltip } from 'antd';
import { DatabaseZap, Info, RefreshCw } from 'lucide-react';
import { WorkbenchButton } from '../../components/WorkbenchButton';
import { pi } from '../../lib/pi';
import { cleanUsageTitle, type UsageFilters, type UsageReport } from '../../lib/usageReport';
import { UsageCharts, useUsageChartMetrics } from './UsageCharts';
import { UsageDetails } from './UsageDetails';
import { UsageKpis, UsageSources } from './UsageOverview';
import styles from './UsagePanel.module.css';

const ranges = [
  { label: '近 7 天', value: '7d' }, { label: '近 30 天', value: '30d' }, { label: '全部时间', value: 'all' },
] as const;
type Range = (typeof ranges)[number]['value'];
type Snapshot = { key: string; report: UsageReport };
let lastReport: Snapshot | null = null;

export function UsagePanel() {
  const chartState = useUsageChartMetrics();
  const [range, setRange] = useState<Range>('all');
  const [projectId, setProjectId] = useState('');
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(lastReport);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const key = JSON.stringify([range, projectId]);
  const report = snapshot?.key === key ? snapshot.report : null;

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    const filters: UsageFilters = { range, ...(projectId && { projectId }), includeAllSessions: true };
    void pi.getUsageReport(filters).then((report) => {
      if (!current) return;
      lastReport = { key, report };
      setSnapshot(lastReport);
    }).catch((e) => {
      if (current) setError(String(e));
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [key, range, projectId, revision]);

  const refresh = () => setRevision(n => n + 1);
  const reconcile = async () => {
    setReconciling(true);
    setNotice(null);
    try {
      const { added } = await pi.reconcileUsage();
      setNotice(added ? `已补录 ${added.toLocaleString('en-US')} 次调用` : '没有需要补录的调用');
      refresh();
    } catch (e) {
      setNotice(`补录失败：${String(e)}`);
    } finally {
      setReconciling(false);
    }
  };

  const projects = snapshot?.report.projects ?? [];
  const legacy = !!snapshot && !snapshot.report.projects;
  return <section className={styles.root} aria-label="用量统计">
    <header className={styles.head}>
      <div className={styles.identity}>
        <h1>用量统计</h1>
        <Tooltip trigger={['hover','focus']} title={<div className={styles.method}>
          按本机时区的自然日统计，每天从当地零点开始。Token、会话数、调用次数与缓存命中率只统计助手调用；费用另含独立预热，按来源列示，不等同于供应商账单。<br />
          外部导入历史仅展示；来源未验证的继承历史不入账。压缩、分支摘要及工具自报用量缺少可靠归属时不计入。
        </div>}>
          <button className={styles.info} type="button" aria-label="口径说明"><Info size={14}/>口径说明</button>
        </Tooltip>
      </div>
      <div className={styles.controls}>
        <Segmented size="small" aria-label="时间范围" value={range} options={[...ranges]} onChange={setRange} disabled={!snapshot || legacy}/>
        <Select size="small" aria-label="筛选项目" className={styles.projectSelect} value={projectId}
          onChange={setProjectId} popupMatchSelectWidth={false} disabled={!projects.length}
          options={[{value: '', label: '全部项目'}, ...projects.map(p => ({ value: p.projectId, label: cleanUsageTitle(p.name) || '未命名项目' }))]}/>
        <div className={styles.actions}>
          <WorkbenchButton size="small" icon={<DatabaseZap size={13}/>} loading={reconciling} disabled={loading || reconciling}
            title="扫描本地会话，补上尚未入账的调用" onClick={() => void reconcile()}>补录</WorkbenchButton>
          <WorkbenchButton size="small" icon={<RefreshCw size={13}/>} disabled={loading} onClick={refresh}>刷新</WorkbenchButton>
        </div>
      </div>
    </header>
    {notice && <div className={styles.notice} role="status">{notice}</div>}
    {error && <div className={styles.notice} role="alert">加载失败：{error} <button type="button" onClick={refresh}>重试</button></div>}
    {report ? <>
      <UsageSources report={report}/>
      <UsageKpis report={report}/>
      <UsageCharts report={report} {...chartState}/>
      <UsageDetails key={key} report={report} range={range} projectId={projectId}/>
    </> : !error && <div className={styles.state} role="status">{snapshot ? '正在读取所选范围…' : '加载中…首次打开会把本地历史会话导入用量账本。'}</div>}
  </section>;
}
