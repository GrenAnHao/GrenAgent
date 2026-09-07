import { useEffect, useMemo, useRef, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import { agentDataApi, type AgentJob } from '../../lib/agentData';
import type { ResourceNavigation, TaskRef, TaskStatus, TaskView } from '../../../electron/agentData/operationsContracts';
import { styles } from './agentDataStyles';
import { operationsStyles as ops } from './operationsStyles';
import { isTerminalTask, redact, taskKey, taskStatusLabels } from './operationsPresentation';
import { TaskDetailDrawer } from './TaskDetailDrawer';

interface JobsPanelProps {
  jobs?: AgentJob[]; tasks?: TaskView[];
  onRefresh?: () => Promise<void> | void; onTrack?: (ref: TaskRef) => void;
  onNavigate?: (navigation: ResourceNavigation) => void;
  selectedJobId?: string; selectedTask?: TaskRef; selectionRequest?: number;
  visible?: boolean; dataReady?: boolean;
  nextCursor?: string; onLoadMore?: () => Promise<void> | void; loadMore?: () => Promise<void> | void; loadingMore?: boolean;
}
const deletionWarning = '删除后不可恢复；仅删除任务记录，不会影响 Wiki、索引或审计记录。';
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
function legacyTaskView(job: AgentJob): TaskView {
  return { ref: { source: 'user', id: job.id }, key: `user:${job.id}`, kind: job.kind, label: job.kind,
    status: job.state, workspace: job.workspace, progress: job.progress, error: job.error,
    createdAt: job.createdAt, updatedAt: job.updatedAt, cancellationRequested: false,
    capabilities: { cancel: job.state === 'pending' || job.state === 'running', retry: false, remove: isTerminalTask(job.state) } };
}

export function JobsPanel({ jobs: inputJobs, tasks: inputTasks, onRefresh, onTrack, onNavigate, selectedJobId, selectedTask,
  selectionRequest, visible = true, dataReady = true, nextCursor, onLoadMore, loadMore, loadingMore = false }: JobsPanelProps) {
  const modern = inputTasks !== undefined;
  const [tasks, setTasks] = useState<TaskView[]>(inputTasks ?? inputJobs?.map(legacyTaskView) ?? []);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | TaskStatus>('all');
  const [group, setGroup] = useState('all');
  const [kind, setKind] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [systemOpen, setSystemOpen] = useState(false);
  const [loading, setLoading] = useState(inputTasks === undefined && inputJobs === undefined);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [selection, setSelection] = useState<TaskRef>();
  const [detailOpen, setDetailOpen] = useState(false);
  const [retryRequest, setRetryRequest] = useState(0);
  const retrySequence = useRef(0);
  const selectedRow = useRef<HTMLTableRowElement>(null);
  const triggerRow = useRef<HTMLButtonElement | null>(null);
  const pendingFocus = useRef(false);
  const pendingScroll = useRef(false);
  const external = selectedTask ?? (selectedJobId ? { source: 'user' as const, id: selectedJobId } : undefined);
  const externalKey = external ? taskKey(external) : '';
  const selectionKey = selection ? taskKey(selection) : '';
  const mutationContext = useRef(0);

  useEffect(() => {
    if (!external) return;
    setSelection(external); setDetailOpen(modern); setRetryRequest(0); setQuery(''); setStatus('all'); setGroup('all'); setKind(''); setWorkspace('');
    if (external.source === 'system') setSystemOpen(true);
    pendingScroll.current = true;
    mutationContext.current++;
  }, [externalKey, selectionRequest]);

  useEffect(() => {
    if (inputTasks !== undefined || inputJobs !== undefined) {
      setTasks(inputTasks ?? inputJobs!.map(legacyTaskView)); setLoading(false); return;
    }
    if (!visible) return;
    let cancelled = false;
    void agentDataApi.jobs.list().then((next) => { if (!cancelled) { setTasks(next.map(legacyTaskView)); setError(undefined); } })
      .catch((cause) => { if (!cancelled) setError(message(cause)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [inputTasks, inputJobs, visible]);

  const filtered = useMemo(() => tasks.filter((task) => {
    const haystack = `${task.label} ${task.kind} ${task.workspace ?? ''} ${task.resourceName ?? ''} ${task.ref.id}`.toLowerCase();
    return (!query.trim() || haystack.includes(query.trim().toLowerCase())) && (status === 'all' || task.status === status)
      && (group === 'all' || (group === 'history') === isTerminalTask(task.status))
      && (!kind || task.kind === kind) && (!workspace || task.workspace === workspace);
  }), [tasks, query, status, group, kind, workspace]);
  const userTasks = filtered.filter((task) => task.ref.source === 'user');
  const systemTasks = filtered.filter((task) => task.ref.source === 'system');
  const removable = userTasks.filter((task) => task.capabilities.remove && isTerminalTask(task.status) && !task.cancellationRequested);

  useEffect(() => {
    if (!visible || query || status !== 'all' || group !== 'all' || kind || workspace || !pendingScroll.current || !selectedRow.current) return;
    if (selection?.source === 'system' && !systemOpen) return;
    selectedRow.current.scrollIntoView?.({ block: 'nearest' }); pendingScroll.current = false;
  }, [filtered, selectionKey, selectionRequest, visible, query, status, group, kind, workspace, systemOpen]);
  useEffect(() => {
    if (!detailOpen && pendingFocus.current) { pendingFocus.current = false; triggerRow.current?.focus(); }
  }, [detailOpen]);

  const refresh = async (deletedIds: string[] = []) => {
    if (deletedIds.length) setTasks((current) => current.filter((task) => task.ref.source !== 'user' || !deletedIds.includes(task.ref.id)));
    await onRefresh?.();
    if (!modern && !onRefresh) setTasks((await agentDataApi.jobs.list()).map(legacyTaskView));
  };
  const check = async (task: TaskView, capability: 'cancel' | 'remove') => {
    const latest = await agentDataApi.tasks.read(task.ref);
    if (!latest || taskKey(latest.ref) !== taskKey(task.ref) || latest.ref.source !== 'user' || !latest.capabilities[capability]) {
      throw new Error(`当前不允许${capability === 'cancel' ? '取消' : '删除'}此任务，请刷新后重试`);
    }
    return latest;
  };
  const mutate = async (task: TaskView, operation: 'cancel' | 'remove') => {
    if (!visible || busyRef.current || task.ref.source !== 'user' || !task.capabilities[operation]) return;
    if (operation === 'remove' && (!isTerminalTask(task.status) || task.cancellationRequested || !window.confirm(`确认删除任务“${task.label}”（${task.workspace ?? ''}）的记录吗？\nID：${task.ref.id}\n${deletionWarning}`))) return;
    const context = mutationContext.current;
    busyRef.current = true; setBusy(true); setError(undefined);
    try {
      if (modern) await check(task, operation);
      if (operation === 'cancel') { await agentDataApi.jobs.cancel(task.ref.id); await refresh(); }
      else { const result = await agentDataApi.jobs.remove(task.ref.id); await refresh(result.deleted ? [task.ref.id] : []); }
    } catch (cause) { if (context === mutationContext.current) setError(message(cause)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const clear = async () => {
    const stable = removable;
    if (!visible || busyRef.current || !stable.length || !window.confirm(`确认清理当前筛选范围内的 ${stable.length} 条已结束任务记录吗？\n仅删除已完成、失败和已取消的用户任务记录。${deletionWarning}`)) return;
    const context = mutationContext.current;
    busyRef.current = true; setBusy(true); setError(undefined);
    try {
      if (modern) await Promise.all(stable.map((task) => check(task, 'remove')));
      const result = await agentDataApi.jobs.clear(stable.map((task) => task.ref.id));
      await refresh(result.deletedIds);
    } catch (cause) { if (context === mutationContext.current) setError(message(cause)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const openTask = (task: TaskView, trigger: HTMLButtonElement, retry = false) => {
    triggerRow.current = trigger; setSelection(task.ref); setDetailOpen(true);
    setRetryRequest(retry ? ++retrySequence.current : 0);
  };
  const renderTable = (items: TaskView[]) => <div className={styles.panelCard}><table className={`${styles.table} ${ops.table}`}><thead><tr><th>任务</th><th>工作区 / 资源</th><th>状态</th><th>进度</th><th>操作</th></tr></thead><tbody>{items.map((task) => {
    const selected = taskKey(task.ref) === selectionKey;
    return <tr key={taskKey(task.ref)} ref={selected ? selectedRow : undefined} aria-selected={selected} className={selected ? styles.selectedRow : undefined}>
      <td>{task.label}{task.error ? <div className={styles.hint}>{String(redact(task.error))}</div> : null}</td>
      <td><div className={styles.pathSummary} title={task.workspace || undefined}>{task.workspace || '—'}</div>{task.resourceName ? <div className={`${styles.hint} ${styles.pathSummary}`} title={task.resourceName}>{task.resourceName}</div> : null}</td>
      <td><span className={`${styles.statusTag} ${task.status === 'running' ? styles.statusRunning : ''} ${task.status === 'failed' ? styles.statusFailed : ''}`}>{task.cancellationRequested ? '正在取消，等待确认' : taskStatusLabels[task.status]}</span>{task.stage ? <div className={styles.hint}>{task.stage}</div> : null}</td>
      <td>{task.progress === undefined || !Number.isFinite(task.progress) ? <span className={styles.hint}>未提供百分比</span> : <span className={styles.progress}><span className={styles.progressTrack}><span className={styles.progressBar} style={{ display: 'block', width: `${Math.max(0, Math.min(100, task.progress))}%` }} /></span>{task.progress}%</span>}{task.processed !== undefined || task.total !== undefined ? <div className={styles.hint}>{task.processed ?? '—'} / {task.total ?? '—'}</div> : null}</td>
      <td><div className={ops.actions}>
        {modern ? <button type="button" className={styles.actionButton} disabled={busy} onClick={(event) => openTask(task, event.currentTarget)}>详情</button> : null}
        {task.ref.source === 'system' ? <span className={styles.hint}>系统只读</span> : <>
          {modern || task.capabilities.cancel ? <button type="button" className={styles.actionButton} disabled={busy || !task.capabilities.cancel} onClick={() => void mutate(task, 'cancel')}><X size={12} aria-hidden="true" />取消</button> : null}
          {modern ? <button type="button" className={styles.actionButton} disabled={busy || !task.capabilities.retry} onClick={(event) => openTask(task, event.currentTarget, true)}>重试</button> : null}
          {modern || task.capabilities.remove ? <button type="button" className={`${styles.actionButton} ${styles.dangerButton}`} disabled={busy || !task.capabilities.remove || task.cancellationRequested} onClick={() => void mutate(task, 'remove')}><Trash2 size={12} aria-hidden="true" />删除</button> : null}
        </>}
      </div></td>
    </tr>;
  })}</tbody></table></div>;

  if (loading) return <div className={styles.state}>正在加载任务...</div>;
  if (!dataReady) return <div className={styles.state}>等待获取任务</div>;
  return <section data-testid="jobs-panel" className={ops.root}>
    <div className={styles.sectionHeading}><h3 className={styles.heading}>任务队列</h3><span className={styles.hint}>已加载 {tasks.length} 项，当前筛选 {filtered.length} 项</span></div>
    <div className={styles.toolbar}>
      <input className={styles.input} aria-label="搜索任务" placeholder="搜索任务、资源或工作区" value={query} onChange={(event) => setQuery(event.target.value)} />
      <select className={styles.select} aria-label="任务状态" value={status} onChange={(event) => setStatus(event.target.value as 'all' | TaskStatus)}><option value="all">全部状态</option>{Object.entries(taskStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      {modern ? <>
        <select className={styles.select} aria-label="任务分组" value={group} onChange={(event) => setGroup(event.target.value)}><option value="all">活动与历史</option><option value="active">活动任务</option><option value="history">历史任务</option></select>
        <select className={styles.select} aria-label="任务类型" value={kind} onChange={(event) => setKind(event.target.value)}><option value="">全部类型</option>{[...new Set(tasks.map((task) => task.kind))].map((value) => <option key={value}>{value}</option>)}</select>
        <select className={styles.select} aria-label="任务工作区" value={workspace} onChange={(event) => setWorkspace(event.target.value)}><option value="">全部工作区</option>{[...new Set(tasks.map((task) => task.workspace).filter(Boolean))].map((value) => <option key={value}>{value}</option>)}</select>
      </> : null}
      <button type="button" className={`${styles.actionButton} ${styles.dangerButton}`} onClick={() => void clear()} disabled={busy || !removable.length}><Trash2 size={12} aria-hidden="true" />清理已结束</button>
    </div>
    {modern ? <p className={styles.hint}>筛选与清理仅作用于已加载的用户任务；系统后台任务只读。</p> : null}
    {error ? <div className={styles.error} role="alert">{String(redact(error))}</div> : null}
    {!userTasks.length ? <div className={styles.state}>暂无匹配任务</div> : renderTable(userTasks)}
    {modern ? <div className={ops.section}><button type="button" className={styles.actionButton} aria-expanded={systemOpen} disabled={busy} onClick={() => setSystemOpen((value) => !value)}>系统后台任务（{systemTasks.length}）{systemOpen ? ' · 收起' : ' · 展开'}</button>{systemOpen ? systemTasks.length ? renderTable(systemTasks) : <p className={styles.hint}>暂无匹配的系统任务</p> : null}</div> : null}
    {nextCursor ? <div className={ops.section}><button type="button" className={styles.actionButton} disabled={loadingMore || busy} onClick={() => void (onLoadMore ?? loadMore)?.()}>{loadingMore ? '正在加载…' : '加载更多任务'}</button></div> : null}
    {modern ? <TaskDetailDrawer taskRef={detailOpen ? selection : undefined} taskView={tasks.find((task) => taskKey(task.ref) === selectionKey)} visible={visible} retryRequest={retryRequest} onClose={() => { pendingFocus.current = true; setDetailOpen(false); }} onRefresh={onRefresh} onTrack={onTrack} onNavigate={onNavigate} onSelect={(ref) => { setRetryRequest(0); setSelection(ref); }} /> : null}
  </section>;
}
