import { useEffect, useState } from 'react';
import { agentDataApi, type AgentJob, type AgentDataStatus } from '../../lib/agentData';
import { MemoryPanel } from './MemoryPanel';
import { WikiPanel } from './WikiPanel';
import { CodeRetrievalPanel } from './CodeRetrievalPanel';

type Tab = 'overview' | 'jobs' | 'memory' | 'wiki' | 'code';

export function AgentDataCenter() {
  const [tab, setTab] = useState<Tab>('overview');
  const [status, setStatus] = useState<AgentDataStatus | null>(null);
  const [jobs, setJobs] = useState<AgentJob[]>([]);
  const [error, setError] = useState<string>();
  const refresh = async () => {
    try { setError(undefined); setStatus(await agentDataApi.status()); setJobs(await agentDataApi.jobs.list()); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { void refresh(); }, []);
  return <section data-testid="agent-data-center" style={{ padding: 24, overflow: 'auto', height: '100%' }}>
    <header style={{ display: 'flex', alignItems: 'center', gap: 12 }}><h2 style={{ margin: 0 }}>Agent 数据</h2><span>{status?.state ?? '加载中'}</span><button onClick={() => void refresh()}>刷新</button></header>
    {error ? <p role="alert">{error}</p> : null}
    <nav style={{ display: 'flex', gap: 8, margin: '20px 0' }}>{(['overview', 'jobs', 'memory', 'wiki', 'code'] as Tab[]).map((item) => <button key={item} aria-pressed={tab === item} onClick={() => setTab(item)}>{item}</button>)}</nav>
    {tab === 'overview' ? <div><p>Runtime 协议 v{status?.version ?? '-'}</p><p>任务 {jobs.length}</p></div> : null}
    {tab === 'jobs' ? <ul>{jobs.map((job) => <li key={job.id}>{job.kind} · {job.state} · {job.progress}%</li>)}</ul> : null}
    {tab === 'memory' ? <MemoryPanel /> : null}
    {tab === 'wiki' ? <WikiPanel /> : null}
    {tab === 'code' ? <CodeRetrievalPanel /> : null}
  </section>;
}
