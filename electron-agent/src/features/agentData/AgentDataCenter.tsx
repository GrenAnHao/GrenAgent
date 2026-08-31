import { useEffect, useState } from 'react';
import { BrainCircuit, BriefcaseBusiness, Code2, Database, FileText, RefreshCw } from 'lucide-react';
import { agentDataApi, type AgentDataStatus, type AgentJob, type CodeGraphStatus, type MemoryOverview, type WikiOverview } from '../../lib/agentData';
import { MemoryPanel } from './MemoryPanel';
import { WikiPanel } from './WikiPanel';
import { CodeRetrievalPanel } from './CodeRetrievalPanel';
import { styles } from './agentDataStyles';

type Tab = 'overview' | 'jobs' | 'memory' | 'wiki' | 'code';
interface AgentDataCenterProps { userId?: string; workspace?: string }

const tabs: Array<{ id: Tab; label: string; Icon: typeof BrainCircuit }> = [
  { id: 'overview', label: '概览', Icon: BrainCircuit },
  { id: 'jobs', label: '任务', Icon: BriefcaseBusiness },
  { id: 'memory', label: 'Memory', Icon: Database },
  { id: 'wiki', label: 'Wiki', Icon: FileText },
  { id: 'code', label: 'Code Retrieval', Icon: Code2 },
];

export function AgentDataCenter({ userId, workspace }: AgentDataCenterProps) {
  const [tab, setTab] = useState<Tab>('overview');
  const [status, setStatus] = useState<AgentDataStatus | null>(null);
  const [jobs, setJobs] = useState<AgentJob[]>([]);
  const [memory, setMemory] = useState<MemoryOverview | null>(null);
  const [wiki, setWiki] = useState<WikiOverview | null>(null);
  const [code, setCode] = useState<CodeGraphStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const refresh = async () => {
    setLoading(true);
    try {
      setError(undefined);
      const [nextStatus, nextJobs] = await Promise.all([agentDataApi.status(), agentDataApi.jobs.list()]);
      setStatus(nextStatus);
      setJobs(nextJobs);
      if (userId && workspace) {
        const [nextMemory, nextWiki, nextCode] = await Promise.all([
          agentDataApi.memory.overview({ userId, workspace }),
          agentDataApi.wiki.overview(workspace),
          agentDataApi.code.status(workspace),
        ]);
        setMemory(nextMemory);
        setWiki(nextWiki);
        setCode(nextCode);
      } else {
        setMemory(null);
        setWiki(null);
        setCode(null);
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, [userId, workspace]);

  return <section className={styles.root} data-testid="agent-data-center">
    <header className={styles.header}>
      <div className={styles.identity}>
        <span className={styles.icon}><BrainCircuit size={18} /></span>
        <div>
          <h2 className={styles.title}>Agent 数据</h2>
          <div className={styles.subtitle}>{workspace ?? '未绑定工作区'}</div>
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
        {!loading && !error && tab === 'overview' ? <Overview status={status} jobs={jobs} memory={memory} wiki={wiki} code={code} workspace={workspace} /> : null}
        {tab === 'jobs' && !loading ? <JobsPreview jobs={jobs} /> : null}
        {tab === 'memory' && !loading ? <MemoryPanel /> : null}
        {tab === 'wiki' && !loading ? <WikiPanel /> : null}
        {tab === 'code' && !loading ? <CodeRetrievalPanel /> : null}
      </div>
    </div>
  </section>;
}

function Overview({ status, jobs, memory, wiki, code, workspace }: { status: AgentDataStatus | null; jobs: AgentJob[]; memory: MemoryOverview | null; wiki: WikiOverview | null; code: CodeGraphStatus | null; workspace?: string }) {
  return <>
    <div className={styles.sectionHeading}><h3 className={styles.heading}>数据概览</h3><span className={styles.hint}>{workspace ? '当前工作区' : '等待工作区上下文'}</span></div>
    <div className={styles.kpis}>
      <Kpi label="Memory" value={memory?.total ?? '-'} meta={memory ? `L0-L3 · ${memory.byLevel.L0}/${memory.byLevel.L1}/${memory.byLevel.L2}/${memory.byLevel.L3}` : '未加载'} />
      <Kpi label="Wiki 页面" value={wiki?.pages ?? '-'} meta={wiki ? formatTime(wiki.latestUpdatedAt) : '未加载'} />
      <Kpi label="Code 文件" value={code?.indexed ? code.files ?? 0 : '-'} meta={code?.indexed ? `${code.nodes ?? 0} 个节点` : '未连接'} />
      <Kpi label="任务" value={jobs.length} meta={status?.state === 'ready' ? 'Runtime 就绪' : 'Runtime 未就绪'} />
    </div>
    <div className={styles.sectionHeading}><h3 className={styles.heading}>模块状态</h3></div>
    <div className={styles.statusGrid}>
      <StatusCard name="Memory Runtime" value={memory ? 'ready' : '未绑定范围'} />
      <StatusCard name="Wiki 索引" value={wiki ? `${wiki.pages} pages` : '未绑定范围'} />
      <StatusCard name="Code Retrieval" value={code?.indexed ? 'indexed' : 'unavailable'} />
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
