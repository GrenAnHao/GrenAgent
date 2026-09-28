import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Badge, Button, Tabs } from 'antd';
import { BrainCircuit, BriefcaseBusiness, Code2, Database, FileText, RefreshCw, ShieldCheck } from 'lucide-react';
import { agentDataApi, type AgentDataStatus, type CodeGraphProject, type MemoryOverview, type ResourceNavigation, type WikiAssetDetail, type WorkbenchOverview } from '../../lib/agentData';
import { MemoryPanel } from './MemoryPanel';
import { WikiPanel } from './WikiPanel';
import { CodeRetrievalPanel } from './CodeRetrievalPanel';
import { JobsPanel } from './JobsPanel';
import { AuditDiagnosticsPanel } from './AuditDiagnosticsPanel';
import { OverviewPanel, type ResourceState } from './OverviewPanel';
import { AgentDataTaskProvider, useAgentDataTaskMonitor } from './AgentDataTaskProvider';
import { PageBanner } from './workbench/PageBanner';
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
  const [libraries, setLibraries] = useState<ResourceState<WikiAssetDetail[]>>({ loading: true });
  const [codeProjects, setCodeProjects] = useState<ResourceState<CodeGraphProject[]>>({ loading: true });
  const [workbench, setWorkbench] = useState<ResourceState<WorkbenchOverview>>({ loading: true });
  const [navigation, setNavigation] = useState<{ target: ResourceNavigation; request: number }>();
  const [refreshToken, setRefreshToken] = useState(0);
  const requestEpoch = useRef(0);

  const refreshResources = useCallback(async () => {
    if (!visible) return;
    const epoch = ++requestEpoch.current;
    setStatus((current) => ({ ...current, loading: true }));
    setMemory((current) => ({ ...current, loading: true }));
    setLibraries((current) => ({ ...current, loading: true }));
    setCodeProjects((current) => ({ ...current, loading: true }));
    setWorkbench((current) => ({ ...current, loading: true }));
    const settle = <T,>(run: () => Promise<T> | undefined) => { try { return Promise.resolve(run()); } catch (cause) { return Promise.reject(cause); } };
    const [statusResult, memoryResult, librariesResult, aggregateResult, codeResult] = await Promise.allSettled([
      settle(() => agentDataApi.status()),
      settle(() => userId ? agentDataApi.memory.overview({ userId, includeOtherProjects: true }) : undefined),
      settle(() => agentDataApi.wiki.list()),
      settle(() => agentDataApi.overview({ userId: userId ?? 'local' })),
      settle(() => agentDataApi.code.projects()),
    ]);
    if (epoch !== requestEpoch.current) return;
    setStatus((current) => applyResult(current, statusResult));
    setMemory((current) => applyResult(current, memoryResult));
    setLibraries((current) => applyResult(current, librariesResult));
    setWorkbench((current) => applyResult(current, aggregateResult));
    setCodeProjects((current) => applyResult(current, codeResult));
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
        return <OverviewPanel memory={memory} workbench={workbench} libraries={libraries} codeProjects={codeProjects} tasks={monitor.tasks} tasksLoaded={monitor.loaded} tasksError={monitor.error} onNavigate={selectTab} onOpenResource={navigate} />;
      case 'memory':
        return <MemoryPanel userId={userId} initialProject={initialProject} visible={visible && tab === 'memory'} refreshToken={refreshToken} onOpenSession={onOpenSession} navigation={navigation?.target.view === 'memory' ? navigation.target : undefined} navigationRequest={navigation?.target.view === 'memory' ? navigation.request : undefined} />;
      case 'wiki':
        return <WikiPanel initialProject={initialProject} visible={visible && tab === 'wiki'} refreshToken={refreshToken} onOpenTask={openTask} navigation={navigation?.target.view === 'wiki' ? navigation.target : undefined} navigationRequest={navigation?.target.view === 'wiki' ? navigation.request : undefined} />;
      case 'code':
        return <CodeRetrievalPanel initialProject={initialProject} visible={visible && tab === 'code'} refreshToken={refreshToken} onOpenTask={openTask} navigation={navigation?.target.view === 'code' ? navigation.target : undefined} navigationRequest={navigation?.target.view === 'code' ? navigation.request : undefined} />;
      case 'jobs':
        return <>
          {monitor.error ? <PageBanner type="error" items={[{ source: '任务', message: monitor.error }]} /> : null}
          <JobsPanel jobs={monitor.jobs} tasks={monitor.tasks} dataReady={monitor.loaded} refreshToken={refreshToken} onRefresh={monitor.refresh} onTrack={monitor.track} selectedTask={navigation?.target.view === 'jobs' ? navigation.target.task : undefined} selectionRequest={navigation?.target.view === 'jobs' ? navigation.request : undefined} visible={visible && tab === 'jobs'} onNavigate={navigate} nextCursor={monitor.nextCursor} onLoadMore={monitor.loadMore} loadingMore={monitor.loadingMore} />
        </>;
      case 'audit':
        return <AuditDiagnosticsPanel visible={visible && tab === 'audit'} refreshToken={refreshToken} navigation={navigation?.target.view === 'audit' ? { resource: navigation.target.resource, request: navigation.request } : undefined} onNavigate={navigate} onRefresh={async () => { await monitor.refresh(); await refreshResources(); }} />;
    }
  }

  const refreshing = status.loading || memory.loading || workbench.loading || libraries.loading || codeProjects.loading;
  const runtimeState = status.error ? 'error' : status.data?.state ?? 'unknown';
  let runtimeLabel = status.loading ? '连接中' : '未获取';
  if (status.data) runtimeLabel = status.data.state === 'closed' ? '已关闭' : `Runtime v${status.data.version}`;
  if (status.error) runtimeLabel = '连接异常';

  const activeTasks = monitor.activeCount;
  const actionRequired = workbench.data?.diagnostics?.actionRequired;
  const refreshAll = () => { setRefreshToken((value) => value + 1); void refreshResources(); void monitor.refresh(); };
  const badge = (id: AgentDataTab) => {
    if (id === 'jobs' && activeTasks) return <Badge count={activeTasks} size="small" title="进行中任务（含后台）" />;
    if (id === 'audit' && actionRequired) return <Badge count={actionRequired} size="small" color="red" title="需要处理的诊断" />;
    return null;
  };

  return <section className={styles.root} data-testid="agent-data-center">
    <Tabs
      id="agent-data"
      activeKey={tab}
      onChange={(key) => selectTab(key as AgentDataTab)}
      className={styles.bodyTabs}
      tabBarExtraContent={{
        left: <div className={styles.brand}><i aria-hidden="true"><BrainCircuit size={14} /></i><span>Agent 数据</span></div>,
        right: <div className={styles.runtime}>
          <Badge status={runtimeState === 'ready' ? 'success' : runtimeState === 'closed' || runtimeState === 'error' ? 'warning' : 'default'} text={runtimeLabel} data-testid="agent-data-runtime" data-state={runtimeState} />
          <Button type="text" aria-label="刷新 Agent 数据" title="刷新 Agent 数据" icon={<RefreshCw size={15} />} disabled={!visible || refreshing} onClick={refreshAll} />
        </div>,
      }}
      items={tabs.map(({ id, label, Icon }) => ({
        key: id,
        label: <span className={styles.tabLabel} title={label}><Icon size={14} aria-hidden="true" /><span data-tab-text>{label}</span>{badge(id)}</span>,
        forceRender: visited.has(id),
        children: <div className={styles.panel}>
          {id === tab && status.error ? <PageBanner type="error" items={[{ source: '运行时', message: status.error }]} /> : null}
          {visited.has(id) ? panelContent(id) : null}
        </div>,
      }))}
    />
  </section>;
}

function applyResult<T>(previous: ResourceState<T>, result: PromiseSettledResult<T | undefined>): ResourceState<T> {
  if (result.status === 'fulfilled') return { data: result.value, loading: false };
  return { ...previous, loading: false, error: result.reason instanceof Error ? result.reason.message : String(result.reason) };
}
