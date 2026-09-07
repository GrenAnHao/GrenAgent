import { useEffect, useRef, useState } from 'react';
import { Drawer } from 'antd';
import { agentDataApi } from '../../lib/agentData';
import type { ResourceNavigation, TaskDetail, TaskRef, TaskRetryPreview, TaskView } from '../../../electron/agentData/operationsContracts';
import { styles } from './agentDataStyles';
import { operationsStyles as ops } from './operationsStyles';
import { redact, resourceNavigation, taskKey, taskStatusLabels } from './operationsPresentation';

interface Props {
  taskRef?: TaskRef; taskView?: TaskView; visible?: boolean; retryRequest?: number; onClose(): void;
  onRefresh?(): Promise<void> | void; onTrack?(ref: TaskRef): void;
  onNavigate?(navigation: ResourceNavigation): void; onSelect?(ref: TaskRef): void;
}
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export function TaskDetailDrawer({ taskRef, taskView, visible = true, retryRequest, onClose, onRefresh, onTrack, onNavigate, onSelect }: Props) {
  const [readDetail, setDetail] = useState<TaskDetail>();
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState<string>();
  const [mutationError, setMutationError] = useState<string>();
  const [loadRequest, setLoadRequest] = useState(0);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<TaskRetryPreview>();
  const [newTask, setNewTask] = useState<TaskRef>();
  const [localRef, setLocalRef] = useState<TaskRef>();
  const externalKey = taskRef ? taskKey(taskRef) : '';
  const previousExternal = useRef(externalKey);
  if (previousExternal.current !== externalKey) { previousExternal.current = externalKey; if (localRef) setLocalRef(undefined); }
  const selected = localRef ?? taskRef;
  const key = selected ? taskKey(selected) : '';
  const session = `${visible}:${key}`;
  const currentSession = useRef(session); currentSession.current = session;
  const epoch = useRef(0);
  const busyRef = useRef(false);
  const detail = readDetail && taskView && taskKey(readDetail.ref) === taskKey(taskView.ref)
    ? { ...readDetail, ...taskView, events: readDetail.events } : readDetail;
  const retryHandled = useRef<string | undefined>(undefined);
  const valid = (request: number) => request === epoch.current && session === currentSession.current && visible && !!selected;

  useEffect(() => {
    const request = ++epoch.current;
    setDetail(undefined); setReadError(undefined); setMutationError(undefined); setPreview(undefined); setNewTask(undefined);
    setBusy(false); busyRef.current = false;
    if (!selected || !visible) { setLoading(false); return; }
    setLoading(true);
    void agentDataApi.tasks.read(selected).then((result) => {
      if (valid(request)) setDetail(result);
    }).catch((cause) => { if (valid(request)) setReadError(message(cause)); })
      .finally(() => { if (valid(request)) setLoading(false); });
    return () => { epoch.current++; };
  }, [key, visible, loadRequest]);

  const prepareRetry = async () => {
    if (!selected || !visible || busyRef.current) return;
    const stable = selected; const request = epoch.current;
    busyRef.current = true; setBusy(true); setMutationError(undefined);
    try {
      const latest = await agentDataApi.tasks.read(stable);
      if (!valid(request)) return;
      if (!latest || latest.ref.source !== 'user' || !latest.capabilities.retry) throw new Error('当前不允许重试此任务');
      const result = await agentDataApi.tasks.previewRetry(stable);
      if (!valid(request)) return;
      if (taskKey(result.ref) !== taskKey(stable)) throw new Error('重试目标不一致，请重新读取');
      if (result.callsModel && (!result.model || result.targetCount === undefined)) throw new Error('无法确认模型或处理范围，请重新读取');
      setPreview(result);
    } catch (cause) { if (valid(request)) setMutationError(message(cause)); }
    finally { if (valid(request)) { busyRef.current = false; setBusy(false); } }
  };

  useEffect(() => {
    const intent = `${key}:${retryRequest}`;
    if (!detail || !retryRequest || !visible || retryHandled.current === intent) return;
    retryHandled.current = intent;
    void prepareRetry();
  }, [readDetail, retryRequest, key, visible]);

  const retry = async () => {
    if (!preview || !selected || taskKey(preview.ref) !== key || busyRef.current || !visible) return;
    const stable = preview; const request = epoch.current;
    busyRef.current = true; setBusy(true); setMutationError(undefined);
    try {
      const result = await agentDataApi.tasks.retry(stable.ref, stable.callsModel ? { expectedModel: stable.model } : undefined);
      if (!valid(request)) return;
      setNewTask(result.ref); setPreview(undefined);
      onTrack?.(result.ref);
      await onRefresh?.();
    } catch (cause) { if (valid(request)) setMutationError(message(cause)); }
    finally { if (valid(request)) { busyRef.current = false; setBusy(false); } }
  };

  return <Drawer open={visible && !!selected} title="任务详情" size="min(560px, 100vw)" closable={!busy} keyboard={!busy} maskClosable={!busy}
    onClose={() => { if (!busyRef.current) onClose(); }} styles={{ wrapper: { maxWidth: '100vw' }, header: { padding: '16px clamp(16px, 3vw, 24px)' }, body: { minWidth: 0, padding: '20px clamp(16px, 3vw, 24px) 32px' } }}>
    <div className={ops.detail}>
      {loading ? <p>正在读取任务详情…</p> : null}
      {readError ? <div role="alert" className={styles.error}>{readError}<button type="button" className={styles.actionButton} onClick={() => setLoadRequest((value) => value + 1)}>重新读取</button></div> : null}
      {!loading && !readError && !detail ? <p>任务记录已移除</p> : null}
      {detail ? <>
        <div className={ops.detailHeader}>
          <div><p className={ops.eyebrow}>任务详情</p><h3>{detail.label}</h3></div>
          <span className={`${styles.statusTag} ${detail.status === 'running' ? styles.statusRunning : ''} ${detail.status === 'failed' ? styles.statusFailed : ''}`}>{detail.cancellationRequested ? '正在取消' : taskStatusLabels[detail.status]}</span>
        </div>
        <section className={ops.detailSection} aria-labelledby="task-info-heading">
          <h4 id="task-info-heading">任务信息</h4>
          <dl><dt>类型</dt><dd>{detail.kind}</dd><dt>ID</dt><dd>{detail.ref.id}</dd><dt>来源</dt><dd>{detail.ref.source === 'system' ? '系统后台（只读）' : '用户任务'}</dd><dt>创建时间</dt><dd>{new Date(detail.createdAt).toLocaleString()}</dd><dt>更新时间</dt><dd>{new Date(detail.updatedAt).toLocaleString()}</dd></dl>
        </section>
        <section className={ops.detailSection} aria-labelledby="task-resource-heading">
          <h4 id="task-resource-heading">资源信息</h4>
          <dl><dt>目标</dt><dd>{detail.resourceName ?? (detail.resource ? `资源已移除（${detail.resource.id}）` : '未关联资源')}</dd><dt>工作区</dt><dd>{detail.workspace || '—'}</dd></dl>
          {detail.resource && onNavigate ? <button type="button" className={styles.actionButton} disabled={busy} onClick={() => onNavigate(resourceNavigation(detail.resource!))}>查看关联资源</button> : null}
        </section>
        <section className={ops.detailSection} aria-labelledby="task-execution-heading">
          <h4 id="task-execution-heading">执行摘要</h4>
          <dl><dt>状态</dt><dd>{detail.cancellationRequested ? '正在取消，等待确认' : taskStatusLabels[detail.status]}</dd><dt>阶段</dt><dd>{detail.stage || '未提供阶段'}</dd><dt>进度</dt><dd>{detail.progress === undefined || !Number.isFinite(detail.progress) ? '未提供百分比' : `${detail.progress}%`}</dd><dt>处理数量</dt><dd>{detail.processed === undefined && detail.total === undefined ? '未提供计数' : `${detail.processed ?? '—'} / ${detail.total ?? '—'}`}</dd><dt>尝试次数</dt><dd>{detail.attempts ?? '未提供'}</dd>{detail.retryOf ? <><dt>重试来源</dt><dd>{detail.retryOf}</dd></> : null}</dl>
          {detail.inputSummary ? <details className={ops.detailDisclosure}><summary>输入摘要</summary><pre>{JSON.stringify(redact(detail.inputSummary), null, 2)}</pre></details> : null}
          {detail.outputSummary ? <details className={ops.detailDisclosure}><summary>结果摘要</summary><pre>{JSON.stringify(redact(detail.outputSummary), null, 2)}</pre></details> : null}
          {detail.error ? <div className={styles.inlineError}>{String(redact(detail.error))}</div> : null}
          {detail.ref.source === 'user' ? <button type="button" className={styles.actionButton} disabled={busy || !detail.capabilities.retry} onClick={() => void prepareRetry()}>重试任务</button> : null}
        </section>
        <section className={ops.detailSection} aria-labelledby="task-events-heading">
          <h4 id="task-events-heading">任务事件</h4>
          {detail.events.length === 0 ? <p className={styles.hint}>暂无任务事件</p> : <ol className={ops.timeline}>{detail.events.map((event) => <li key={event.id}><div>{String(redact(event.message))}</div><small>{event.action} · {new Date(event.createdAt).toLocaleString()}</small></li>)}</ol>}
        </section>
      </> : null}
      {mutationError ? <div role="alert" className={styles.error}>{mutationError}</div> : null}
      {preview ? <div className={ops.confirm} aria-label="重试确认">
        <p>新建任务，保留旧记录。旧任务的失败状态和审计历史不会更改。</p>
        {preview.callsModel ? <><p>将调用模型：<strong>{preview.model}</strong></p><p>本次处理 {preview.targetCount} 份来源，可能产生模型费用。</p></> : <p>此任务不调用模型。</p>}
        <div className={ops.actions}>
          <button type="button" className={styles.actionButton} disabled={busy} onClick={() => setPreview(undefined)}>取消重试</button>
          <button type="button" className={styles.actionButton} disabled={busy} onClick={() => void prepareRetry()}>重新读取重试范围</button>
          <button type="button" className={styles.actionButton} disabled={busy} onClick={() => void retry()}>确认重试</button>
        </div>
      </div> : null}
      {newTask ? <p>已创建新任务 <button type="button" className={styles.actionButton} disabled={busy} onClick={() => { onSelect?.(newTask); setLocalRef(newTask); }}>查看新任务（{newTask.id}）</button></p> : null}
    </div>
  </Drawer>;
}
