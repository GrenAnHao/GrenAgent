import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { agentDataApi, type AgentJob, type AgentJobState } from '../../lib/agentData';
import { styles } from './agentDataStyles';

interface JobsPanelProps {
  jobs?: AgentJob[];
  onRefresh?: () => Promise<void> | void;
}

const stateLabels: Record<AgentJobState, string> = {
  pending: '等待中',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export function JobsPanel({ jobs: inputJobs, onRefresh }: JobsPanelProps) {
  const [jobs, setJobs] = useState<AgentJob[]>(inputJobs ?? []);
  const [query, setQuery] = useState('');
  const [state, setState] = useState<'all' | AgentJobState>('all');
  const [loading, setLoading] = useState(inputJobs === undefined);
  const [error, setError] = useState<string>();
  const [cancelling, setCancelling] = useState<string>();

  useEffect(() => {
    if (inputJobs !== undefined) {
      setJobs(inputJobs);
      setLoading(false);
      return;
    }
    let cancelled = false;
    void agentDataApi.jobs.list()
      .then((next) => { if (!cancelled) setJobs(next); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [inputJobs]);

  const filteredJobs = useMemo(() => jobs.filter((job) => {
    const matchesQuery = !query.trim() || `${job.kind} ${job.workspace}`.toLowerCase().includes(query.trim().toLowerCase());
    return matchesQuery && (state === 'all' || job.state === state);
  }), [jobs, query, state]);

  const cancel = async (id: string) => {
    setCancelling(id);
    try {
      setError(undefined);
      await agentDataApi.jobs.cancel(id);
      await onRefresh?.();
      if (!onRefresh) setJobs(await agentDataApi.jobs.list());
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setCancelling(undefined); }
  };

  if (loading) return <div className={styles.state}>正在加载任务...</div>;
  return <section data-testid="jobs-panel">
    <div className={styles.sectionHeading}><h3 className={styles.heading}>任务队列</h3><span className={styles.hint}>{filteredJobs.length}/{jobs.length} 项</span></div>
    <div className={styles.toolbar}>
      <input className={styles.input} aria-label="搜索任务" placeholder="搜索任务或项目" value={query} onChange={(event) => setQuery(event.target.value)} />
      <select className={styles.select} aria-label="任务状态" value={state} onChange={(event) => setState(event.target.value as 'all' | AgentJobState)}>
        <option value="all">全部状态</option>
        {Object.entries(stateLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </div>
    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    {filteredJobs.length === 0 ? <div className={styles.state}>暂无匹配任务</div> : <table className={styles.table}><thead><tr><th>任务</th><th>工作区</th><th>状态</th><th>进度</th><th>操作</th></tr></thead><tbody>{filteredJobs.map((job) => <tr key={job.id}>
      <td>{job.kind}{job.error ? <div className={styles.hint}>{job.error}</div> : null}</td>
      <td>{job.workspace}</td>
      <td><span className={`${styles.statusTag} ${job.state === 'running' ? styles.statusRunning : ''} ${job.state === 'failed' ? styles.statusFailed : ''} ${job.state === 'cancelled' ? styles.statusCancelled : ''}`}>{stateLabels[job.state]}</span></td>
      <td><span className={styles.progress}><span className={styles.progressTrack}><span className={styles.progressBar} style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }} /></span>{job.progress}%</span></td>
      <td>{job.state === 'pending' || job.state === 'running' ? <button type="button" className={styles.actionButton} onClick={() => void cancel(job.id)} disabled={cancelling === job.id}><X size={12} />取消</button> : null}</td>
    </tr>)}</tbody></table>}
  </section>;
}
