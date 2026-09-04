import { useEffect, useState } from 'react';
import { BrainCircuit, BriefcaseBusiness, Code2, Database, FileText, RefreshCw, ShieldCheck } from 'lucide-react';
import { agentDataApi, type AgentDataStatus, type AgentJob, type MemoryOverview, type WikiOverview } from '../../lib/agentData';
import { MemoryPanel } from './MemoryPanel';
import { WikiPanel } from './WikiPanel';
import { CodeRetrievalPanel } from './CodeRetrievalPanel';
import { JobsPanel } from './JobsPanel';
import { AuditDiagnosticsPanel } from './AuditDiagnosticsPanel';
import { styles } from './agentDataStyles';

type Tab = 'overview' | 'jobs' | 'memory' | 'wiki' | 'code' | 'audit';
interface AgentDataCenterProps {
  userId?: string;
  /** 仅作为各子面板筛选器的初始值；面板打开后不再跟随对话/项目切换。 */
  initialProject?: string;
}

const tabs: Array<{ id: Tab; label: string; Icon: typeof BrainCircuit }> = [
  { id: 'overview', label: '概览', Icon: BrainCircuit },
  { id: 'jobs', label: '任务', Icon: BriefcaseBusiness },
  { id: 'memory', label: 'Memory', Icon: Database },
  { id: 'wiki', label: 'Wiki', Icon: FileText },
  { id: 'code', label: 'Code Retrieval', Icon: Code2 },
  { id: 'audit', label: '审计诊断', Icon: ShieldCheck },
];

export function AgentDataCenter({ userId, initialProject }: AgentDataCenterProps) {
  const [tab, setTab] = useState<Tab>('overview');
  const [status, setStatus] = useState<AgentDataStatus | null>(null);
  const [jobs, setJobs] = useState<AgentJob[]>([]);
  const [memory, setMemory] = useState<MemoryOverview | null>(null);
  const [wiki, setWiki] = useState<WikiOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const refresh = async () => {
    setLoading(true);
    try {
      setError(undefined);
      const [nextStatus, nextJobs] = await Promise.all([agentDataApi.status(), agentDataApi.jobs.list()]);
      setStatus(nextStatus);
      setJobs(nextJobs);
      // Memory/Wiki 默认统计全部项目；Code 需要显式选定项目，概览里不预取。
      const [nextMemory, nextWiki] = await Promise.all([
        userId ? agentDataApi.memory.overview({ userId, includeOtherProjects: true }) : Promise.resolve(null),
        agentDataApi.wiki.overview(undefined),
      ]);
      setMemory(nextMemory);
      setWiki(nextWiki);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };
  // 刻意只依赖 userId：initialProject 变化（用户在侧栏切对话）不应该重查整个面板。
  useEffect(() => { void refresh(); }, [userId]);

  return <section className={styles.root} data-testid="agent-data-center">
    <header className={styles.header}>
      <div className={styles.identity}>
        <span className={styles.icon}><BrainCircuit size={18} /></span>
        <div>
          <h2 className={styles.title}>Agent 数据</h2>
          <div className={styles.subtitle}>全部项目 · {jobs.length} 个任务</div>
        </div>
      </div>
      <div className={styles.headerActions}>
        <span className={styles.runtime}>
          <span className={`${styles.runtimeDot} ${status?.state === 'closed' ? styles.runtimeDotClosed : ''}`} />
          {loading ? '加载中' : status?.state === 'closed' ? '已关闭' : `Runtime v${status?.version ?? '-'}`}
        </span>
        <button type="button" className={styles.iconButton} aria-label="刷新 Agent 数据" title="刷新 Agent 数据" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={15} />
        </button>
      </div>
    </header>
    <nav className={styles.nav} aria-label="Agent 数据模块">
      {tabs.map(({ id, label, Icon }) => <button key={id} type="button" className={`${styles.tab} ${tab === id ? styles.tabActive : ''}`} aria-pressed={tab === id} onClick={() => setTab(id)}>
        <Icon size={14} />{label}
      </button>)}
    </nav>
    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    <div className={styles.body}>
      <div className={styles.content}>
        {loading && !status ? <div className={styles.state}>正在加载 Agent Data...</div> : null}
        {!loading && !error && tab === 'overview' ? <Overview status={status} jobs={jobs} memory={memory} wiki={wiki} /> : null}
        {tab === 'jobs' && !loading ? <JobsPanel jobs={jobs} workspace={initialProject} onCreate={async (kind, targetWorkspace) => { await agentDataApi.jobs.create({ kind, workspace: targetWorkspace }); await refresh(); }} onRefresh={refresh} /> : null}
        {tab === 'memory' && !loading ? <MemoryPanel userId={userId} initialProject={initialProject} /> : null}
        {tab === 'wiki' && !loading ? <WikiPanel initialProject={initialProject} onJobCreated={() => setTab('jobs')} /> : null}
        {tab === 'code' && !loading ? <CodeRetrievalPanel initialProject={initialProject} onJobCreated={() => setTab('jobs')} /> : null}
        {tab === 'audit' && !loading ? <AuditDiagnosticsPanel /> : null}
      </div>
    </div>
  </section>;
}

function Overview({ status, jobs, memory, wiki }: { status: AgentDataStatus | null; jobs: AgentJob[]; memory: MemoryOverview | null; wiki: WikiOverview | null }) {
  return <>
    <div className={styles.sectionHeading}><h3 className={styles.heading}>数据概览</h3><span className={styles.hint}>全部项目</span></div>
    <div className={styles.kpis}>
      <Kpi label="Memory" value={memory?.total ?? '-'} meta={memory ? `L0-L3 · ${memory.byLevel.L0}/${memory.byLevel.L1}/${memory.byLevel.L2}/${memory.byLevel.L3}` : '未加载'} />
      <Kpi label="Wiki 页面" value={wiki?.pages ?? '-'} meta={wiki ? formatTime(wiki.latestUpdatedAt) : '未加载'} />
      <Kpi label="Code 索引" value="—" meta="在 Code Retrieval 选择项目查看" />
      <Kpi label="任务" value={jobs.length} meta={status?.state === 'ready' ? 'Runtime 就绪' : 'Runtime 未就绪'} />
    </div>
    <div className={styles.sectionHeading}><h3 className={styles.heading}>模块状态</h3></div>
    <div className={styles.statusGrid}>
      <StatusCard name="Memory Runtime" value={memory ? 'ready' : '未加载'} />
      <StatusCard name="Wiki 索引" value={wiki ? `${wiki.pages} pages` : '未加载'} />
      <StatusCard name="Code Retrieval" value="按项目查看" />
    </div>
    <div className={styles.sectionHeading}><h3 className={styles.heading}>最近任务</h3><span className={styles.hint}>{jobs.length} 项</span></div>
    <JobsPreview jobs={jobs} />
  </>;
}

function Kpi({ label, value, meta }: { label: string; value: string | number; meta: string }) {
  return <div className={styles.card}><div className={styles.cardLabel}>{label}</div><div className={styles.cardValue}>{value}</div><div className={styles.cardMeta}>{meta}</div></div>;
}

function StatusCard({ name, value }: { name: string; value: string }) {
  return <div className={styles.card}><div className={styles.statusRow}><span className={styles.statusName}>{name}</span><span className={styles.statusValue}>{value}</span></div></div>;
}

function JobsPreview({ jobs }: { jobs: AgentJob[] }) {
  if (jobs.length === 0) return <div className={styles.state}>暂无任务</div>;
  return <table className={styles.table}><thead><tr><th>任务</th><th>状态</th><th>进度</th></tr></thead><tbody>{jobs.slice(0, 8).map((job) => <tr key={job.id}><td>{job.kind}</td><td>{job.state}</td><td>{job.progress}%</td></tr>)}</tbody></table>;
}

function formatTime(timestamp: number | null): string {
  return timestamp === null ? '暂无更新' : `更新于 ${new Date(timestamp).toLocaleString()}`;
}
