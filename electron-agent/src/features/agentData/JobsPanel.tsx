import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Empty, Input, Progress, Select, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { Trash2, X } from 'lucide-react';
import { agentDataApi, type AgentJob } from '../../lib/agentData';
import type { ResourceNavigation, TaskRef, TaskStatus, TaskView } from '../../../electron/agentData/operationsContracts';
import { styles } from './agentDataStyles';
import { operationsStyles as ops } from './operationsStyles';
import { isTerminalTask, redact, taskKey, taskStatusColors, taskStatusLabels, uniqueTaskKindOptions, workspaceFilterLabel } from './operationsPresentation';
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
// antd 会为「恰好两个汉字且无图标」的按钮插入空格（重试 → 重 试），改变可访问名称。
// 带图标的按钮不受影响，纯文字按钮显式关掉插入以保持标签原文。
const autoInsertSpace = false;
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
  const triggerRow = useRef<HTMLElement | null>(null);
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
  const kindOptions = useMemo(() => [{ value: '', label: '全部类型' }, ...uniqueTaskKindOptions(tasks)], [tasks]);
  const workspaceOptions = useMemo(() => {
    const paths = [...new Set(tasks.map((task) => task.workspace).filter(Boolean) as string[])];
    return [{ value: '', label: '全部工作区' }, ...paths.map((value) => ({ value, label: workspaceFilterLabel(value, paths), title: value }))];
  }, [tasks]);
  const removable = userTasks.filter((task) => task.capabilities.remove && isTerminalTask(task.status) && !task.cancellationRequested);

  useEffect(() => {
    if (!visible || query || status !== 'all' || group !== 'all' || kind || workspace || !pendingScroll.current) return;
    if (selection?.source === 'system' && !systemOpen) return;
    const row = selectionKey ? document.querySelector<HTMLElement>(`tr[data-row-key="${selectionKey}"]`) : null;
    if (!row) return;
    row.scrollIntoView?.({ block: 'nearest' }); pendingScroll.current = false;
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
  const openTask = (task: TaskView, trigger: HTMLElement, retry = false) => {
    triggerRow.current = trigger; setSelection(task.ref); setDetailOpen(true);
    setRetryRequest(retry ? ++retrySequence.current : 0);
  };

  const columns: TableColumnsType<TaskView> = [
    { title: '任务', key: 'label', width: '28%', render: (_, task) => (
      <div>{task.label}{task.error ? <div><Typography.Text type="secondary">{String(redact(task.error))}</Typography.Text></div> : null}</div>
    ) },
    { title: '工作区 / 资源', key: 'workspace', width: '24%', render: (_, task) => (
      <>
        <div className={styles.pathSummary} title={task.workspace || undefined}>{task.workspace || '—'}</div>
        {task.resourceName ? <div className={styles.pathSummary} title={task.resourceName}><Typography.Text type="secondary">{task.resourceName}</Typography.Text></div> : null}
      </>
    ) },
    { title: '状态', key: 'status', width: '14%', render: (_, task) => (
      <>
        <Tag color={taskStatusColors[task.status]}>{task.cancellationRequested ? '正在取消，等待确认' : taskStatusLabels[task.status]}</Tag>
        {task.stage ? <div><Typography.Text type="secondary">{task.stage}</Typography.Text></div> : null}
      </>
    ) },
    { title: '进度', key: 'progress', width: 160, render: (_, task) => (
      <>
        {task.progress === undefined || !Number.isFinite(task.progress)
          ? <Typography.Text type="secondary">未提供百分比</Typography.Text>
          : <Progress percent={task.progress} size="small" />}
        {task.processed !== undefined || task.total !== undefined
          ? <div><Typography.Text type="secondary">{task.processed ?? '—'} / {task.total ?? '—'}</Typography.Text></div> : null}
      </>
    ) },
    { title: '操作', key: 'actions', width: 190, render: (_, task) => (
      <Space size={4} wrap>
        {modern ? <Button size="small" autoInsertSpace={autoInsertSpace} disabled={busy} onClick={(event) => openTask(task, event.currentTarget)}>详情</Button> : null}
        {task.ref.source === 'system' ? <Typography.Text type="secondary">系统只读</Typography.Text> : <>
          {modern || task.capabilities.cancel ? <Button size="small" icon={<X size={12} aria-hidden="true" />} disabled={busy || !task.capabilities.cancel} onClick={() => void mutate(task, 'cancel')}>取消</Button> : null}
          {modern ? <Button size="small" autoInsertSpace={autoInsertSpace} disabled={busy || !task.capabilities.retry} onClick={(event) => openTask(task, event.currentTarget, true)}>重试</Button> : null}
          {modern || task.capabilities.remove ? <Button size="small" danger icon={<Trash2 size={12} aria-hidden="true" />} disabled={busy || !task.capabilities.remove || task.cancellationRequested} onClick={() => void mutate(task, 'remove')}>删除</Button> : null}
        </>}
      </Space>
    ) },
  ];
  // antd 会给「恰好两个汉字」的按钮插入空格（取消 → 取 消），会改变可访问名称；
  // 这里保持标签原文，便于断言与读屏一致。
  const renderTable = (items: TaskView[]) => <Table<TaskView>
    rowKey={(task) => taskKey(task.ref)}
    size="small"
    tableLayout="fixed"
    pagination={false}
    columns={columns}
    dataSource={items}
    onRow={(task) => {
      const selected = taskKey(task.ref) === selectionKey;
      return { 'aria-selected': selected, className: selected ? styles.selectedRow : undefined };
    }}
    locale={{ emptyText: '暂无匹配任务' }}
  />;

  if (loading) return <Empty className={ops.root} description="正在加载任务..." />;
  if (!dataReady) return <Empty className={ops.root} description="等待获取任务" />;
  return <section data-testid="jobs-panel" className={ops.root}>
    <div className={styles.sectionHeading}><h3 className={styles.heading}>任务队列</h3><Typography.Text type="secondary">已加载 {tasks.length} 项，当前筛选 {filtered.length} 项</Typography.Text></div>
    <div className={styles.toolbar}>
      <Input aria-label="搜索任务" placeholder="搜索任务、资源或工作区" value={query} onChange={(event) => setQuery(event.target.value)} style={{ minWidth: 220, flex: 1 }} />
      <Select aria-label="任务状态" value={status} style={{ minWidth: 120 }} onChange={(value) => setStatus(value as 'all' | TaskStatus)}
        options={[{ value: 'all', label: '全部状态' }, ...Object.entries(taskStatusLabels).map(([value, label]) => ({ value, label }))]} />
      {modern ? <>
        <Select aria-label="任务分组" value={group} style={{ minWidth: 120 }} onChange={(value) => setGroup(value)}
          options={[{ value: 'all', label: '活动与历史' }, { value: 'active', label: '活动任务' }, { value: 'history', label: '历史任务' }]} />
        <Select aria-label="任务类型" value={kind} popupMatchSelectWidth={false} classNames={{ popup: { root: ops.filterPopup } }} style={{ minWidth: 148 }} onChange={(value) => setKind(value)}
          options={kindOptions} />
        <Select aria-label="任务工作区" value={workspace} popupMatchSelectWidth={false} classNames={{ popup: { root: ops.filterPopup } }} style={{ minWidth: 168 }} onChange={(value) => setWorkspace(value)}
          options={workspaceOptions} />
      </> : null}
      <Button danger icon={<Trash2 size={12} aria-hidden="true" />} onClick={() => void clear()} disabled={busy || !removable.length}>清理已结束</Button>
    </div>
    {modern ? <div><Typography.Text type="secondary">筛选与清理仅作用于已加载的用户任务；系统后台任务只读。</Typography.Text></div> : null}
    {error ? <Alert type="error" showIcon title={String(redact(error))} /> : null}
    {!userTasks.length ? <Empty description="暂无匹配任务" /> : renderTable(userTasks)}
    {modern ? <div className={ops.section}><Button aria-expanded={systemOpen} disabled={busy} onClick={() => setSystemOpen((value) => !value)}>系统后台任务（{systemTasks.length}）{systemOpen ? ' · 收起' : ' · 展开'}</Button>{systemOpen ? systemTasks.length ? renderTable(systemTasks) : <Typography.Text type="secondary">暂无匹配的系统任务</Typography.Text> : null}</div> : null}
    {nextCursor ? <div className={ops.section}><Button disabled={loadingMore || busy} onClick={() => void (onLoadMore ?? loadMore)?.()}>{loadingMore ? '正在加载…' : '加载更多任务'}</Button></div> : null}
    {modern ? <TaskDetailDrawer taskRef={detailOpen ? selection : undefined} taskView={tasks.find((task) => taskKey(task.ref) === selectionKey)} visible={visible} retryRequest={retryRequest} onClose={() => { pendingFocus.current = true; setDetailOpen(false); }} onRefresh={onRefresh} onTrack={onTrack} onNavigate={onNavigate} onSelect={(ref) => { setRetryRequest(0); setSelection(ref); }} /> : null}
  </section>;
}
