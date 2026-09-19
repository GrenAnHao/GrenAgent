import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Badge, Button, Tabs, Typography } from 'antd';
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

  function panelContent(id: AgentDataTab): ReactNode {
    switch (id) {
      case 'overview':
        return <OverviewPanel memory={memory} wiki={wiki} jobs={monitor.jobs} tasks={monitor.tasks} workbench={workbench} jobsLoading={monitor.loading} jobsLoaded={monitor.loaded} jobsError={monitor.error} onNavigate={selectTab} onOpenTask={openTask} onOpenResource={navigate} />;
      case 'memory':
        return <MemoryPanel userId={userId} initialProject={initialProject} visible={visible && tab === 'memory'} onOpenSession={onOpenSession} navigation={navigation?.target.view === 'memory' ? navigation.target : undefined} navigationRequest={navigation?.target.view === 'memory' ? navigation.request : undefined} />;
      case 'wiki':
        return <WikiPanel initialProject={initialProject} visible={visible && tab === 'wiki'} onOpenTask={openTask} navigation={navigation?.target.view === 'wiki' ? navigation.target : undefined} navigationRequest={navigation?.target.view === 'wiki' ? navigation.request : undefined} />;
      case 'code':
        return <CodeRetrievalPanel initialProject={initialProject} visible={visible && tab === 'code'} onOpenTask={openTask} navigation={navigation?.target.view === 'code' ? navigation.target : undefined} navigationRequest={navigation?.target.view === 'code' ? navigation.request : undefined} />;
      case 'jobs':
        return <>
          {monitor.error ? <Alert type="error" showIcon title={monitor.error} /> : null}
          <JobsPanel jobs={monitor.jobs} tasks={monitor.tasks} dataReady={monitor.loaded} onRefresh={monitor.refresh} onTrack={monitor.track} selectedTask={navigation?.target.view === 'jobs' ? navigation.target.task : undefined} selectionRequest={navigation?.target.view === 'jobs' ? navigation.request : undefined} visible={visible && tab === 'jobs'} onNavigate={navigate} nextCursor={monitor.nextCursor} onLoadMore={monitor.loadMore} loadingMore={monitor.loadingMore} />
        </>;
      case 'audit':
        return <AuditDiagnosticsPanel visible={visible && tab === 'audit'} navigation={navigation?.target.view === 'audit' ? { resource: navigation.target.resource, request: navigation.request } : undefined} onNavigate={navigate} onRefresh={async () => { await monitor.refresh(); await refreshResources(); }} />;
    }
  }

  const refreshing = status.loading || memory.loading || wiki.loading;
  const runtimeState = status.error ? 'error' : status.data?.state ?? 'unknown';
  let runtimeLabel = status.loading ? '连接中' : '未获取';
  if (status.data) runtimeLabel = status.data.state === 'closed' ? '已关闭' : `Runtime v${status.data.version}`;
  if (status.error) runtimeLabel = '连接异常';

  return <section className={styles.root} data-testid="agent-data-center">
    <header className={styles.header}>
      <div className={styles.identity}><span className={styles.icon}><BrainCircuit size={18} /></span><div>
        <Typography.Title level={5} className={styles.title}>Agent 数据</Typography.Title>
        <Typography.Text type="secondary" className={styles.subtitle}>全部项目 · {monitor.loaded ? `已加载 ${monitor.tasks.length} 个任务` : '任务未获取'}</Typography.Text>
      </div></div>
      <div className={styles.headerActions}>
        <Badge
          status={runtimeState === 'ready' ? 'success' : runtimeState === 'closed' || runtimeState === 'error' ? 'warning' : 'default'}
          text={runtimeLabel}
          data-testid="agent-data-runtime"
          data-state={runtimeState}
        />
        <Button type="text" aria-label="刷新 Agent 数据" title="刷新 Agent 数据" icon={<RefreshCw size={15} />} disabled={!visible || refreshing} onClick={() => { void refreshResources(); void monitor.refresh(); }} />
      </div>
    </header>
    {status.error ? <Alert type="error" showIcon title={`运行时：${status.error}`} /> : null}
    <Tabs
      id="agent-data"
      activeKey={tab}
      onChange={(key) => selectTab(key as AgentDataTab)}
      className={styles.bodyTabs}
      tabBarStyle={{ paddingInline: 24 }}
      items={tabs.map(({ id, label, Icon }) => ({
        key: id,
        label: <><Icon size={14} /> {label}</>,
        forceRender: visited.has(id),
        children: <div className={styles.panel}>{visited.has(id) ? panelContent(id) : null}</div>,
      }))}
    />
  </section>;
}

function applyResult<T>(previous: ResourceState<T>, result: PromiseSettledResult<T | undefined>): ResourceState<T> {
  if (result.status === 'fulfilled') return { data: result.value, loading: false };
  return { ...previous, loading: false, error: result.reason instanceof Error ? result.reason.message : String(result.reason) };
}
