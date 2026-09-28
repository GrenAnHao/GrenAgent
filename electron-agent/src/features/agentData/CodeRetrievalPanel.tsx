import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Empty, Input, Segmented, Tag, Typography, type InputRef } from 'antd';
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
import { codeIndexPresentation } from './codeIndexPresentation';
import { formatRelative } from '../../lib/relativeTime';
import { openPath } from '../../platform/runtime';
import { PageHeader } from './workbench/PageHeader';
import { PageBanner, type BannerItem } from './workbench/PageBanner';
import { MoreMenu } from './workbench/MoreMenu';
import { SplitPane } from './workbench/SplitPane';
import { workbenchStyles as w } from './workbench/workbenchStyles';

interface CodeRetrievalPanelProps {
  /** 仅从真实项目选项中预选；用户手动切换后不再跟随其变化。 */
  initialProject?: string;
  visible?: boolean;
  /** 统一刷新令牌；与本地「刷新状态」计数相加驱动状态/查询重读。 */
  refreshToken?: number;
  navigation?: Extract<ResourceNavigation, { view: 'code' }>;
  navigationRequest?: number;
  onOpenTask?: (id: string) => void;
}
interface QueryState { workspace: string; result?: CodeResultView; retained?: CodeResultView; error?: string; loading: boolean }
const jobStateLabels = { pending: '等待中', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消' };
function projectKey(workspace: string): string { return workspace.replace(/\\/g, '/').replace(/^\/\/\?\//, '').replace(/\/+$/, '').toLowerCase(); }

export function CodeRetrievalPanel({ initialProject, visible = true, refreshToken = 0, navigation, navigationRequest = 0, onOpenTask }: CodeRetrievalPanelProps) {
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
  const [statusVersion, setStatusVersion] = useState(0);
  const reload = refreshToken + statusVersion;
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
  const view = codeIndexPresentation({ status: currentStatus, checking, error: statusError });
  // 页头/标签用 view（受 checking 与刷新错误影响）；查询能力只看最近一次成功读到的状态，
  // 这样一次失败的状态刷新不会抹掉仍可读的旧结果，也不会让查询 effect 因 canQuery 抖动而多发一次请求。
  const canQuery = Boolean(project) && Boolean(currentStatus) && codeIndexPresentation({ status: currentStatus, checking: false }).canQuery;
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
    setStatusVersion((value) => value + 1);
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
  }, [visible, monitor.watchedTaskVersion, reload]);

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
  }, [project, visible, monitor.watchedTaskVersion, reload]);

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
  }, [project, canQuery, query, queryTool, visible, monitor.watchedTaskVersion, reload]);

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
    if (!project || syncing || !visible || view.primary === 'none') return;
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

  const errorItems: BannerItem[] = [];
  if (createdTask && monitor.error) errorItems.push({ message: `任务状态刷新失败：${monitor.error}；显示的旧状态不是最新结果。` });
  if (taskError) errorItems.push({ message: taskError });
  if (indexError) errorItems.push({ message: indexError });
  const bannerMessage = view.banner?.message ?? '';
  const showExtraMessage = Boolean(currentStatus?.message) && !bannerMessage.includes(currentStatus!.message!);

  return <section data-testid="code-retrieval-panel" className={styles.root}>
    <PageHeader title="代码索引"
      extra={<>
        <CodeProjectList options={options} project={project} indexState={indexState} status={statusError ? undefined : currentStatus} onSelect={selectProject} />
        {project ? <Tag color={view.color}>{view.label}</Tag> : null}
        {project && currentStatus?.indexed ? <span className={styles.stats}>
          <span>{currentStatus.files ?? '未提供'} 文件</span><span>{currentStatus.nodes ?? '未提供'} 节点</span><span>{currentStatus.edges ?? '未提供'} 边</span>
          {currentStatus.lastIndexedAt ? <span title={new Date(currentStatus.lastIndexedAt).toLocaleString()}>同步于 {formatRelative(currentStatus.lastIndexedAt)}</span> : null}
        </span> : null}
      </>}
      actions={project ? <>
        {view.primary !== 'none' ? <Button type={view.primary === 'build' ? 'primary' : 'default'} disabled={!visible || syncing} onClick={() => void sync()}>{view.primary === 'build' ? '建立索引' : '同步索引'}</Button> : null}
        <MoreMenu label="代码索引更多操作" items={[{ key: 'status', label: '刷新状态' }, { key: 'open', label: '打开项目目录' }]}
          onSelect={(key) => { if (key === 'status') setStatusVersion((v) => v + 1); if (key === 'open') void openPath(project).catch((cause) => setTaskError(errorText(cause))); }} />
      </> : null} />
    {errorItems.length ? <PageBanner type="error" items={errorItems} /> : null}
    {createdTask ? <PageBanner type="info" items={[{ message: <>{`已加入任务 · ${nameOf(createdTask.workspace)} · ${createdTask.workspace} · `}<span>{taskSummary ? `${monitor.error ? '上次获取：' : ''}${taskSummary}` : '任务状态未获取'}</span></> }]}
      action={<Button autoInsertSpace={false} onClick={() => onOpenTask?.(createdTask.id)} disabled={!onOpenTask}>查看任务</Button>} /> : null}
    {view.banner ? <PageBanner type={view.banner.type} items={[{ message: view.banner.message }]}
      action={view.banner.sync ? <Button size="small" onClick={() => void sync()}>同步</Button> : undefined} /> : null}
    {showExtraMessage ? <PageBanner type="error" items={[{ message: currentStatus!.message! }]} /> : null}
    {!project ? <Empty description="请选择一个项目" /> : view.primary === 'build' ? <div className={w.empty}>
      这个项目还没有索引
      <Typography.Text type="secondary">{project}</Typography.Text>
      <Button type="primary" disabled={!visible || syncing} onClick={() => void sync()}>建立索引</Button>
    </div> : <div className={w.panel}>
      <div className={w.panelToolbar}>
        <Input ref={queryInput} aria-label="搜索代码" placeholder={mode === 'search' ? '搜索符号或文件名；留空浏览文件' : '描述要找的功能'} value={query} onChange={(event) => changeQuery(event.target.value)} disabled={!canQuery} style={{ flex: 1 }} />
        <Segmented value={mode} disabled={!canQuery} onChange={(value) => changeMode(value as 'search' | 'explore')} options={[{ value: 'search', label: '符号' }, { value: 'explore', label: '相关上下文', disabled: !query.trim() }]} />
      </div>
      <SplitPane detailOpen={Boolean(selected)}
        side={<div className={styles.column} data-code-list>
          {currentResult?.result ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{currentResult.result.rows.length} 个结果</Typography.Text> : null}
          {currentResult?.loading ? <Typography.Text type="secondary" role="status">正在查询代码…</Typography.Text> : null}
          {currentResult?.error ? <Alert type="error" showIcon title={`${currentResult.error}${currentResult.result ? ' 当前显示上次成功读取的结果。' : ''}`} /> : null}
          {currentResult?.result ? <CodeResultContent result={currentResult.result} retained={currentResult.retained} onSelect={selectResult} selected={selected} tool={queryTool} /> : null}
        </div>}
        main={selected ? <div className={styles.column} aria-label="代码详情">
          <div className={w.detailHeader}><Typography.Title level={5} style={{ margin: 0 }}>{selected.symbol ?? selected.file ?? '代码详情'}</Typography.Title><Button className={w.spacer} onClick={closeDetail}>返回结果列表</Button></div>
          {selected.file ? <CodeSourceDetail workspace={project} file={selected.file} line={selected.line} visible={visible && canQuery} reloadVersion={reload + monitor.watchedTaskVersion} /> : <Typography.Text type="secondary">未提供文件位置，无法打开源码。</Typography.Text>}
          {currentNode?.loading ? <Typography.Text type="secondary" role="status">正在读取符号上下文…</Typography.Text> : null}
          {currentNode?.error ? <Alert type="error" showIcon title={currentNode.error} /> : null}
          {currentNode?.result ? <details open={currentNode.result.isError || undefined}><summary>符号上下文</summary><CodeResultContent result={currentNode.result} retained={currentNode.retained} /></details> : null}
          {selected.symbol ? <CodeRelations workspace={project} symbol={selected.symbol} nodeId={selected.id} file={selected.file} visible={visible && canQuery} reloadVersion={reload + monitor.watchedTaskVersion} /> : <Typography.Text type="secondary">未提供符号，无法查询调用关系。</Typography.Text>}
        </div> : <div className={w.empty}>搜索符号或文件，选择结果查看源码与调用关系</div>} />
    </div>}
  </section>;
}

function errorText(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
