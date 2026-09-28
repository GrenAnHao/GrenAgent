import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Empty, Input, Typography, type InputRef } from 'antd';
import { RefreshCw, Search } from 'lucide-react';
import { agentDataApi, type CodeGraphProject, type CodeGraphStatus, type CodeRetrievalRequest, type ResourceNavigation } from '../../lib/agentData';
import { pathsEquivalent } from '../../lib/pathUtils';
import { useAgentDataTaskMonitor } from './AgentDataTaskProvider';
import { CodeProjectList } from './CodeProjectList';
import { CodeRelations, CodeResultContent, codeRequestError } from './CodeRelations';
import { CodeSourceDetail } from './CodeSourceDetail';
import { decodeCodeResult, retainedCodeResult, type CodeResultRow, type CodeResultView } from './codeResult';
import { codeStyles as styles } from './codeStyles';
import { useProjectOptions } from './useProjectOptions';
import { taskStatusLabels } from './operationsPresentation';

interface CodeRetrievalPanelProps {
  /** 仅从真实项目选项中预选；用户手动切换后不再跟随其变化。 */
  initialProject?: string;
  visible?: boolean;
  /** 统一刷新令牌；本任务仅声明以保持类型正确，面板刷新逻辑在任务 7 接入。 */
  refreshToken?: number;
  navigation?: Extract<ResourceNavigation, { view: 'code' }>;
  navigationRequest?: number;
  onOpenTask?: (id: string) => void;
}
interface QueryState { workspace: string; result?: CodeResultView; retained?: CodeResultView; error?: string; loading: boolean }
const jobStateLabels = { pending: '等待中', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消' };
function projectKey(workspace: string): string { return workspace.replace(/\\/g, '/').replace(/^\/\/\?\//, '').replace(/\/+$/, '').toLowerCase(); }

export function CodeRetrievalPanel({ initialProject, visible = true, navigation, navigationRequest = 0, onOpenTask }: CodeRetrievalPanelProps) {
  const options = useProjectOptions();
  const monitor = useAgentDataTaskMonitor();
  const initial = useRef(initialProject);
  const initialMatch = options.find((option) => initial.current && pathsEquivalent(option.cwd, initial.current))?.cwd;
  const initialized = useRef(Boolean(initialMatch));
  const [selectedProject, setProject] = useState(initialMatch ?? '');
  const project = options.find((option) => pathsEquivalent(option.cwd, selectedProject))?.cwd ?? '';
  const [indexState, setIndexState] = useState<CodeGraphProject[]>();
  const [indexError, setIndexError] = useState<string>();
  const [status, setStatus] = useState<CodeGraphStatus>();
  const [statusError, setStatusError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [query, setQuery] = useState('');
  const queries = useRef(new Map<string, string>());
  const [mode, setMode] = useState<'search' | 'explore'>('search');
  const [queryState, setQueryState] = useState<QueryState>();
  const [selected, setSelected] = useState<CodeResultRow>();
  const [selectionVersion, setSelectionVersion] = useState(0);
  const [nodeState, setNodeState] = useState<QueryState>();
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [createdTask, setCreatedTask] = useState<{ id: string; workspace: string }>();
  const [taskError, setTaskError] = useState<string>();
  const [pendingNavigation, setPendingNavigation] = useState<{ key: string; workspace: string; file: string; line?: number }>();
  const handledNavigation = useRef<string | undefined>(undefined);
  const navigationKey = navigation ? JSON.stringify([navigation.workspace, navigation.file, navigation.line, navigationRequest]) : '';
  const navigationProject = navigation?.workspace ? options.find((option) => pathsEquivalent(option.cwd, navigation.workspace!))?.cwd : undefined;
  const statusEpoch = useRef(0);
  const queryEpoch = useRef(0);
  const nodeEpoch = useRef(0);
  const mounted = useRef(false);
  const resultTrigger = useRef<HTMLElement | null>(null);
  const queryInput = useRef<InputRef>(null);
  const restoreFocus = useRef(false);
  const currentStatus = status && pathsEquivalent(status.workspace, project) ? status : undefined;
  const canQuery = Boolean(project && currentStatus?.indexed && currentStatus.sdkAvailable !== false && currentStatus.state !== 'indexing');
  const currentResult = queryState?.workspace === project ? queryState : undefined;
  const currentNode = nodeState?.workspace === project ? nodeState : undefined;
  let queryTool: 'codegraph_search' | 'codegraph_explore' | 'codegraph_files' = 'codegraph_files';
  if (query.trim()) queryTool = mode === 'search' ? 'codegraph_search' : 'codegraph_explore';

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; statusEpoch.current++; queryEpoch.current++; nodeEpoch.current++; };
  }, []);

  useEffect(() => {
    if (!initialized.current && initialMatch) { initialized.current = true; setProject(initialMatch); }
  }, [initialMatch]);

  useEffect(() => {
    if (!visible || !navigation || handledNavigation.current === navigationKey || !navigationProject) return;
    handledNavigation.current = navigationKey;
    selectProject(navigationProject);
    statusEpoch.current++; queryEpoch.current++; nodeEpoch.current++;
    setStatus(undefined); setStatusError(undefined); setQueryState(undefined); setNodeState(undefined); setSelected(undefined);
    restoreFocus.current = false; resultTrigger.current = null;
    setPendingNavigation(navigation.file ? { key: navigationKey, workspace: navigationProject, file: navigation.file, line: navigation.line } : undefined);
    setRefreshVersion((value) => value + 1);
  }, [navigationKey, navigationProject, visible]);

  useEffect(() => {
    if (!visible || !canQuery || !pendingNavigation || pendingNavigation.key !== navigationKey || !pathsEquivalent(pendingNavigation.workspace, project)) return;
    setSelected({ file: pendingNavigation.file, line: pendingNavigation.line });
    setSelectionVersion((value) => value + 1);
    setPendingNavigation(undefined);
  }, [pendingNavigation, navigationKey, project, canQuery, visible]);

  useEffect(() => {
    if (!selectedProject || project) return;
    initialized.current = true;
    statusEpoch.current++; queryEpoch.current++; nodeEpoch.current++;
    queries.current.set(projectKey(selectedProject), query);
    setProject(''); setQuery(''); setStatus(undefined); setStatusError(undefined);
    setQueryState(undefined); setNodeState(undefined); setSelected(undefined); setChecking(false);
    restoreFocus.current = false; resultTrigger.current = null;
  }, [selectedProject, project, query]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setIndexError(undefined);
    void agentDataApi.code.projects()
      .then((value) => { if (!cancelled) setIndexState(value); })
      .catch((cause) => { if (!cancelled) setIndexError(`索引参考读取失败：${errorText(cause)}`); });
    return () => { cancelled = true; };
  }, [visible, monitor.watchedTaskVersion, refreshVersion]);

  useEffect(() => {
    const epoch = ++statusEpoch.current;
    if (!visible || !project) return;
    setChecking(true);
    setStatusError(undefined);
    void agentDataApi.code.status(project)
      .then((value) => {
        if (epoch !== statusEpoch.current) return;
        if (!pathsEquivalent(value.workspace, project)) {
          setStatusError('返回的 CodeGraph 索引状态与当前项目不匹配');
          return;
        }
        setStatus(value);
      })
      .catch((cause) => { if (epoch === statusEpoch.current) setStatusError(codeRequestError(cause)); })
      .finally(() => { if (epoch === statusEpoch.current) setChecking(false); });
    return () => { statusEpoch.current++; };
  }, [project, visible, monitor.watchedTaskVersion, refreshVersion]);

  useEffect(() => {
    const epoch = ++queryEpoch.current;
    if (!visible || !canQuery) return;
    setQueryState((old) => ({ workspace: project, result: old?.workspace === project ? old.result : undefined, retained: old?.workspace === project ? old.retained : undefined, loading: true }));
    const request: CodeRetrievalRequest = queryTool === 'codegraph_files'
      ? { workspace: project, tool: queryTool, args: { format: 'flat' } }
      : { workspace: project, tool: queryTool, args: { query: query.trim(), limit: 20 } };
    void agentDataApi.code.call(request)
      .then((raw) => {
        if (epoch !== queryEpoch.current) return;
        const result = decodeCodeResult(queryTool, raw);
        setQueryState((old) => ({ workspace: project, result, retained: retainedCodeResult(result, old?.result, old?.retained), loading: false }));
      })
      .catch((cause) => {
        if (epoch === queryEpoch.current) setQueryState((old) => ({ ...old, workspace: project, error: codeRequestError(cause), loading: false }));
      });
    return () => { queryEpoch.current++; };
  }, [project, canQuery, query, queryTool, visible, monitor.watchedTaskVersion, refreshVersion]);

  useEffect(() => {
    const epoch = ++nodeEpoch.current;
    if (!visible || !project || !selected?.symbol || !canQuery) return;
    setNodeState((old) => ({ workspace: project, result: old?.workspace === project ? old.result : undefined, retained: old?.workspace === project ? old.retained : undefined, loading: true }));
    void agentDataApi.code.call({ workspace: project, tool: 'codegraph_node', args: { symbol: selected.id ?? selected.symbol, ...(selected.file ? { file: selected.file } : {}), includeCode: true } })
      .then((raw) => {
        if (epoch !== nodeEpoch.current) return;
        const result = decodeCodeResult('codegraph_node', raw);
        setNodeState((old) => ({ workspace: project, result, retained: retainedCodeResult(result, old?.result, old?.retained), loading: false }));
      })
      .catch((cause) => {
        if (epoch === nodeEpoch.current) setNodeState((old) => ({ ...old, workspace: project, error: codeRequestError(cause), loading: false }));
      });
    return () => { nodeEpoch.current++; };
  }, [project, selected?.id, selected?.symbol, selected?.file, selectionVersion, canQuery, visible, monitor.watchedTaskVersion]);

  useEffect(() => {
    if (selected || !restoreFocus.current || !visible) return;
    restoreFocus.current = false;
    if (resultTrigger.current?.isConnected) resultTrigger.current.focus();
    else queryInput.current?.focus();
  }, [selected, visible]);

  function selectProject(next: string) {
    const target = options.find((option) => pathsEquivalent(option.cwd, next))?.cwd ?? '';
    initialized.current = true;
    if (target === project) return;
    setPendingNavigation(undefined);
    statusEpoch.current++; queryEpoch.current++; nodeEpoch.current++;
    queries.current.set(projectKey(project), query);
    setProject(target);
    setQuery(queries.current.get(projectKey(target)) ?? '');
    setStatus(undefined); setStatusError(undefined); setQueryState(undefined); setNodeState(undefined);
    setSelected(undefined); setIndexError(undefined); setChecking(false);
    restoreFocus.current = false; resultTrigger.current = null;
  }

  function changeQuery(next: string) {
    queryEpoch.current++;
    setQuery(next);
    queries.current.set(projectKey(project), next);
  }

  function selectResult(row: CodeResultRow, trigger: HTMLElement) {
    nodeEpoch.current++;
    resultTrigger.current = trigger;
    setNodeState(undefined);
    setSelected(row);
    setSelectionVersion((value) => value + 1);
  }

  function changeMode(next: 'search' | 'explore') {
    if (next === mode) return;
    queryEpoch.current++;
    setMode(next);
  }

  function closeDetail() {
    nodeEpoch.current++;
    restoreFocus.current = true;
    setSelected(undefined); setNodeState(undefined);
  }

  async function sync() {
    if (!project || syncing || !visible || !currentStatus || checking || statusError) return;
    const targetProject = project;
    const trackCreated = monitor.track;
    setSyncing(true); setTaskError(undefined);
    try {
      const job = await agentDataApi.jobs.create({ kind: 'codegraph.sync', workspace: targetProject });
      trackCreated(job.id);
      if (mounted.current) setCreatedTask({ id: job.id, workspace: job.workspace });
    } catch (cause) {
      if (mounted.current) setTaskError(`任务创建失败 · ${nameOf(targetProject)}（${targetProject}）：${errorText(cause)}`);
    } finally { if (mounted.current) setSyncing(false); }
  }

  function nameOf(workspace: string) { return options.find((option) => pathsEquivalent(option.cwd, workspace))?.name ?? workspace; }
  const trackedJob = monitor.jobs.find((job) => job.id === createdTask?.id);
  const trackedTask = monitor.tasks?.find((task) => task.ref.source === 'user' && task.ref.id === createdTask?.id);
  let taskSummary: string | undefined;
  if (trackedTask) {
    const progress = typeof trackedTask.progress === 'number' ? `${trackedTask.progress}%` : trackedTask.stage || '进度未提供';
    const label = trackedTask.cancellationRequested ? '正在取消 · 等待确认' : taskStatusLabels[trackedTask.status];
    taskSummary = `${label} · ${progress}${trackedTask.error ? ` · ${trackedTask.error}` : ''}`;
  } else if (trackedJob) taskSummary = `${jobStateLabels[trackedJob.state]} · ${trackedJob.progress}%${trackedJob.error ? ` · ${trackedJob.error}` : ''}`;
  let statusLabel = '未检查';
  if (currentStatus) statusLabel = `索引状态：${currentStatus.state ?? (currentStatus.indexed ? '已索引' : '未索引')}`;
  if (checking) statusLabel = '正在检查 CodeGraph…';

  return <section data-testid="code-retrieval-panel" className={styles.root}>
    <div className={styles.heading}><Typography.Title level={5} style={{ margin: 0 }}>Code Retrieval</Typography.Title><Typography.Text type="secondary">项目内只读检索</Typography.Text></div>
    <CodeProjectList options={options} project={project} indexState={indexState} status={statusError ? undefined : currentStatus} onSelect={selectProject} />
    {createdTask ? <div className={styles.card} role="status">
      <div title={createdTask.workspace}>已加入任务 · {nameOf(createdTask.workspace)} · {createdTask.workspace}</div>
      <div className={styles.toolbar}>
        {taskSummary ? <Typography.Text type="secondary">{monitor.error ? '上次获取：' : ''}{taskSummary}</Typography.Text> : <Typography.Text type="secondary">任务状态未获取</Typography.Text>}
        <Button onClick={() => onOpenTask?.(createdTask.id)} disabled={!onOpenTask}>查看任务</Button>
      </div>
    </div> : null}
    {createdTask && monitor.error ? <Alert type="error" showIcon title={`任务状态刷新失败：${monitor.error}；显示的旧状态不是最新结果。`} /> : null}
    {taskError ? <Alert type="error" showIcon title={taskError} /> : null}
    {indexError ? <Alert type="error" showIcon title={indexError} /> : null}
    {statusError ? <Alert type="error" showIcon title={`${statusError}${currentStatus ? ' 当前保留上次成功读取的索引状态。' : ''}`} /> : null}
    {!project ? <Empty description="请选择一个项目" /> : <>
      <div className={styles.toolbar}>
        <Button icon={<RefreshCw size={12} />} disabled={!visible || checking} onClick={() => setRefreshVersion((value) => value + 1)}>刷新代码工作区</Button>
        {currentStatus && !statusError ? <Button type="primary" disabled={!visible || syncing || checking} onClick={() => void sync()}>{currentStatus.indexed ? '同步索引' : '建立索引'}</Button> : null}
        <Typography.Text type="secondary">{statusLabel}</Typography.Text>
      </div>
      {!currentStatus ? <Typography.Text type="secondary">尚未获取 CodeGraph 索引状态</Typography.Text> : null}
      {currentStatus?.message ? <Alert type="error" showIcon title={currentStatus.message} /> : null}
      {currentStatus && !currentStatus.indexed ? <Alert type="warning" showIcon title="该项目尚未建立 CodeGraph 索引" description="点「建立索引」创建该项目的索引任务。" /> : null}
      {currentStatus ? <div className={styles.card}><Typography.Text type="secondary">文件 / 节点 / 边</Typography.Text><div>{currentStatus.files ?? '未提供'} / {currentStatus.nodes ?? '未提供'} / {currentStatus.edges ?? '未提供'}</div></div> : null}
      <div className={styles.layout} data-detail={Boolean(selected)}>
        <div className={styles.column} data-code-list>
          <div className={styles.toolbar}>
            <Search size={14} />
            <Input ref={queryInput} aria-label="搜索代码" placeholder="搜索文件或符号；留空浏览文件" value={query} onChange={(event) => changeQuery(event.target.value)} disabled={!canQuery} style={{ flex: 1 }} />
          </div>
          <div className={styles.toolbar}>
            <Button size="small" aria-pressed={mode === 'search'} disabled={!canQuery} onClick={() => changeMode('search')}>符号搜索</Button>
            <Button size="small" aria-pressed={mode === 'explore'} disabled={!canQuery || !query.trim()} onClick={() => changeMode('explore')}>相关上下文</Button>
          </div>
          {currentResult?.loading ? <Typography.Text type="secondary" role="status">正在查询代码…</Typography.Text> : null}
          {currentResult?.error ? <Alert type="error" showIcon title={`${currentResult.error}${currentResult.result ? ' 当前显示上次成功读取的结果。' : ''}`} /> : null}
          {currentResult?.result ? <CodeResultContent result={currentResult.result} retained={currentResult.retained} onSelect={selectResult} selected={selected} tool={queryTool} /> : null}
        </div>
        {selected ? <div className={styles.column} aria-label="代码详情">
          <div className={styles.heading}><Typography.Title level={5} style={{ margin: 0 }}>{selected.symbol ?? selected.file ?? '代码详情'}</Typography.Title><Button onClick={closeDetail}>返回结果列表</Button></div>
          {selected.file ? <CodeSourceDetail workspace={project} file={selected.file} line={selected.line} visible={visible && canQuery} /> : <Typography.Text type="secondary">未提供文件位置，无法打开源码。</Typography.Text>}
          {currentNode?.loading ? <Typography.Text type="secondary" role="status">正在读取符号上下文…</Typography.Text> : null}
          {currentNode?.error ? <Alert type="error" showIcon title={currentNode.error} /> : null}
          {currentNode?.result ? <details open={currentNode.result.isError || undefined}><summary>符号上下文</summary><CodeResultContent result={currentNode.result} retained={currentNode.retained} /></details> : null}
          {selected.symbol ? <CodeRelations workspace={project} symbol={selected.symbol} nodeId={selected.id} file={selected.file} visible={visible && canQuery} reloadVersion={monitor.watchedTaskVersion} /> : <Typography.Text type="secondary">未提供符号，无法查询调用关系。</Typography.Text>}
        </div> : null}
      </div>
    </>}
  </section>;
}

function errorText(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
