import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { BrainCircuit, BriefcaseBusiness, Code2, Database, FileText, RefreshCw, ShieldCheck } from 'lucide-react';
import { agentDataApi, type AgentDataStatus, type MemoryOverview, type WikiOverview, type ResourceNavigation, type WorkbenchOverview } from '../../lib/agentData';
import { MemoryPanel } from './MemoryPanel';
import { WikiPanel } from './WikiPanel';
import { CodeRetrievalPanel } from './CodeRetrievalPanel';
import { JobsPanel } from './JobsPanel';
import { AuditDiagnosticsPanel } from './AuditDiagnosticsPanel';
import { OverviewPanel, type ResourceState } from './OverviewPanel';
import { AgentDataTaskProvider, useAgentDataTaskMonitor } from './AgentDataTaskProvider';
import type { AgentDataTab } from './agentDataViewTypes';
import { styles } from './agentDataStyles';

interface AgentDataCenterProps {
  userId?: string;
  /** Only the first visit initializes project filters. */
  initialProject?: string;
  visible?: boolean;
  onOpenSession?: (cwd: string, path: string) => void | Promise<void>;
}

const tabs: Array<{ id: AgentDataTab; label: string; Icon: typeof BrainCircuit }> = [
  { id: 'overview', label: '概览', Icon: BrainCircuit },
  { id: 'memory', label: 'Memory', Icon: Database },
  { id: 'wiki', label: 'Wiki', Icon: FileText },
  { id: 'code', label: '代码索引', Icon: Code2 },
  { id: 'jobs', label: '任务', Icon: BriefcaseBusiness },
  { id: 'audit', label: '审计诊断', Icon: ShieldCheck },
];

export function AgentDataCenter({ userId, initialProject, visible = true, onOpenSession }: AgentDataCenterProps) {
  const [tab, setTab] = useState<AgentDataTab>('overview');
  const [project] = useState(initialProject);
  return <AgentDataTaskProvider key={userId ?? 'local'} visible={visible} activeView={tab}>
    <AgentDataContent userId={userId} initialProject={project} visible={visible} tab={tab} onSelectTab={setTab} onOpenSession={onOpenSession} />
  </AgentDataTaskProvider>;
}

function AgentDataContent({ userId, initialProject, visible, tab, onSelectTab, onOpenSession }: AgentDataCenterProps & { visible: boolean; tab: AgentDataTab; onSelectTab(tab: AgentDataTab): void }) {
  const monitor = useAgentDataTaskMonitor();
  const [visited, setVisited] = useState<Set<AgentDataTab>>(() => new Set([tab]));
  const [status, setStatus] = useState<ResourceState<AgentDataStatus>>({ loading: true });
  const [memory, setMemory] = useState<ResourceState<MemoryOverview>>({ loading: true });
  const [wiki, setWiki] = useState<ResourceState<WikiOverview>>({ loading: true });
  const [workbench, setWorkbench] = useState<ResourceState<WorkbenchOverview>>({ loading: true });
  const [navigation, setNavigation] = useState<{ target: ResourceNavigation; request: number }>();
  const requestEpoch = useRef(0);
  const tabButtons = useRef<Partial<Record<AgentDataTab, HTMLButtonElement | null>>>({});

  const refreshResources = useCallback(async () => {
    if (!visible) return;
    const epoch = ++requestEpoch.current;
    setStatus((current) => ({ ...current, loading: true }));
    setMemory((current) => ({ ...current, loading: true }));
    setWiki((current) => ({ ...current, loading: true }));
    setWorkbench((current) => ({ ...current, loading: true }));
    const [statusResult, memoryResult, wikiResult, aggregateResult] = await Promise.allSettled([
      agentDataApi.status(),
      userId ? agentDataApi.memory.overview({ userId, includeOtherProjects: true }) : Promise.resolve(undefined),
      agentDataApi.wiki.overview(undefined),
      agentDataApi.overview({ userId: userId ?? 'local' }),
    ]);
    if (epoch !== requestEpoch.current) return;
    setStatus((current) => applyResult(current, statusResult));
    setMemory((current) => applyResult(current, memoryResult));
    setWiki((current) => applyResult(current, wikiResult));
    setWorkbench((current) => applyResult(current, aggregateResult));
  }, [userId, visible]);

  useEffect(() => {
    void refreshResources();
    return () => { requestEpoch.current += 1; };
  }, [refreshResources, monitor.watchedTaskVersion]);

  function selectTab(next: AgentDataTab): void {
    setVisited((current) => new Set([...current, next]));
    onSelectTab(next);
    if (next === 'overview') void refreshResources();
  }

  function openTask(id: string): void {
    navigate({ view: 'jobs', task: { source: 'user', id } });
  }

  function navigate(target: ResourceNavigation): void {
    setNavigation((previous) => ({ target, request: (previous?.request ?? 0) + 1 }));
    if (target.view === 'jobs' && target.task) monitor.track(target.task);
    selectTab(target.view);
  }

  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    selectTab(tabs[next].id);
    tabButtons.current[tabs[next].id]?.focus();
  }

  function panel(id: AgentDataTab, content: ReactNode): ReactNode {
    if (!visited.has(id)) return null;
    return <section key={id} role="tabpanel" id={`agent-data-${id}`} aria-labelledby={`agent-data-tab-${id}`} hidden={tab !== id} className={styles.panel}>{content}</section>;
  }

  const refreshing = status.loading || memory.loading || wiki.loading;
  const runtimeState = status.error ? 'error' : status.data?.state ?? 'unknown';
  let runtimeLabel = status.loading ? '连接中' : '未获取';
  if (status.data) runtimeLabel = status.data.state === 'closed' ? '已关闭' : `Runtime v${status.data.version}`;
  if (status.error) runtimeLabel = '连接异常';

  return <section className={styles.root} data-testid="agent-data-center">
    <header className={styles.header}>
      <div className={styles.identity}><span className={styles.icon}><BrainCircuit size={18} /></span><div>
        <h2 className={styles.title}>Agent 数据</h2>
        <div className={styles.subtitle}>全部项目 · {monitor.loaded ? `已加载 ${monitor.tasks.length} 个任务` : '任务未获取'}</div>
      </div></div>
      <div className={styles.headerActions}>
        <span className={styles.runtime} data-testid="agent-data-runtime" data-state={runtimeState}>
          <span className={`${styles.runtimeDot} ${runtimeState === 'ready' ? styles.runtimeDotReady : ''} ${runtimeState === 'closed' || runtimeState === 'error' ? styles.runtimeDotClosed : ''}`} />
          {runtimeLabel}
        </span>
        <button type="button" className={styles.iconButton} aria-label="刷新 Agent 数据" title="刷新 Agent 数据" onClick={() => { void refreshResources(); void monitor.refresh(); }} disabled={!visible || refreshing}>
          <RefreshCw size={15} />
        </button>
      </div>
    </header>
    <nav className={styles.nav} role="tablist" aria-label="Agent 数据模块">
      {tabs.map(({ id, label, Icon }, index) => <button key={id} ref={(button) => { tabButtons.current[id] = button; }} id={`agent-data-tab-${id}`} role="tab" aria-controls={`agent-data-${id}`} aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} type="button" className={`${styles.tab} ${tab === id ? styles.tabActive : ''}`} onClick={() => selectTab(id)} onKeyDown={(event) => moveTab(event, index)}>
        <Icon size={14} />{label}
      </button>)}
    </nav>
    {status.error ? <div className={styles.error} role="alert">运行时：{status.error}</div> : null}
    <div className={styles.body}>
      {panel('overview', <OverviewPanel memory={memory} wiki={wiki} jobs={monitor.jobs} tasks={monitor.tasks} workbench={workbench} jobsLoading={monitor.loading} jobsLoaded={monitor.loaded} jobsError={monitor.error} onNavigate={selectTab} onOpenTask={openTask} onOpenResource={navigate} />)}
      {panel('memory', <MemoryPanel userId={userId} initialProject={initialProject} visible={visible && tab === 'memory'} onOpenSession={onOpenSession} navigation={navigation?.target.view === 'memory' ? navigation.target : undefined} navigationRequest={navigation?.target.view === 'memory' ? navigation.request : undefined} />)}
      {panel('wiki', <WikiPanel initialProject={initialProject} visible={visible && tab === 'wiki'} onOpenTask={openTask} navigation={navigation?.target.view === 'wiki' ? navigation.target : undefined} navigationRequest={navigation?.target.view === 'wiki' ? navigation.request : undefined} />)}
      {panel('code', <CodeRetrievalPanel initialProject={initialProject} visible={visible && tab === 'code'} onOpenTask={openTask} navigation={navigation?.target.view === 'code' ? navigation.target : undefined} navigationRequest={navigation?.target.view === 'code' ? navigation.request : undefined} />)}
      {panel('jobs', <>
        {monitor.error ? <div className={styles.inlineError} role="alert">{monitor.error}</div> : null}
        <JobsPanel jobs={monitor.jobs} tasks={monitor.tasks} dataReady={monitor.loaded} onRefresh={monitor.refresh} onTrack={monitor.track} selectedTask={navigation?.target.view === 'jobs' ? navigation.target.task : undefined} selectionRequest={navigation?.target.view === 'jobs' ? navigation.request : undefined} visible={visible && tab === 'jobs'} onNavigate={navigate} nextCursor={monitor.nextCursor} onLoadMore={monitor.loadMore} loadingMore={monitor.loadingMore} />
      </>)}
      {panel('audit', <AuditDiagnosticsPanel visible={visible && tab === 'audit'} navigation={navigation?.target.view === 'audit' ? { resource: navigation.target.resource, request: navigation.request } : undefined} onNavigate={navigate} onRefresh={async () => { await monitor.refresh(); await refreshResources(); }} />)}
    </div>
  </section>;
}

function applyResult<T>(previous: ResourceState<T>, result: PromiseSettledResult<T | undefined>): ResourceState<T> {
  if (result.status === 'fulfilled') return { data: result.value, loading: false };
  return { ...previous, loading: false, error: result.reason instanceof Error ? result.reason.message : String(result.reason) };
}
