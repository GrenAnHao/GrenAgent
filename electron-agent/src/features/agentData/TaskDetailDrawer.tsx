import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Card, Collapse, Descriptions, Drawer, Flex, Space, Tag, Timeline, Typography } from 'antd';
import { agentDataApi } from '../../lib/agentData';
import type { ResourceNavigation, TaskDetail, TaskRef, TaskRetryPreview, TaskView } from '../../../electron/agentData/operationsContracts';
import { redact, resourceNavigation, taskKey, taskStatusColors, taskStatusLabels } from './operationsPresentation';
import { PageBanner } from './workbench/PageBanner';
import type { RepoWikiKnowledgeSnapshot } from '../../../shared/knowledgeKernelContracts';
import { knowledgeErrorText, projectKnowledge } from '../repoWiki/knowledgeProjection';
import { KnowledgeActiveItems } from '../repoWiki/KnowledgeActiveItems';

interface Props {
  taskRef?: TaskRef; taskView?: TaskView; visible?: boolean; retryRequest?: number; onClose(): void;
  onRefresh?(): Promise<void> | void; onTrack?(ref: TaskRef): void;
  onNavigate?(navigation: ResourceNavigation): void; onSelect?(ref: TaskRef): void;
}
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
function resourceTarget(detail: TaskDetail): string {
  if (detail.resourceName) return detail.resourceName;
  if (detail.resource?.type === 'project' || detail.resource?.type === 'repoWiki') return detail.resource.id;
  if (detail.resource) return `资源已移除（${detail.resource.id}）`;
  return '未关联资源';
}

export function TaskDetailDrawer({ taskRef, taskView, visible = true, retryRequest, onClose, onRefresh, onTrack, onNavigate, onSelect }: Props) {
  const [readDetail, setDetail] = useState<TaskDetail>();
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState<string>();
  const [mutationError, setMutationError] = useState<string>();
  const [loadRequest, setLoadRequest] = useState(0);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<TaskRetryPreview>();
  const previewCard = useRef<HTMLDivElement>(null);
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
  const detailKnowledge = (readDetail as (TaskDetail & { knowledge?: RepoWikiKnowledgeSnapshot }) | undefined)?.knowledge;
  const listKnowledge = (taskView as (TaskView & { knowledge?: RepoWikiKnowledgeSnapshot }) | undefined)?.knowledge;
  const olderList = detailKnowledge?.run && listKnowledge?.run && detailKnowledge.run.taskId === listKnowledge.run.taskId && detailKnowledge.run.revision > listKnowledge.run.revision;
  const detail = !olderList && readDetail && taskView && taskKey(readDetail.ref) === taskKey(taskView.ref)
    ? { ...readDetail, ...taskView, events: readDetail.events } : readDetail;
  const retryHandled = useRef<string | undefined>(undefined);
  const detailNative = readDetail?.nativeWiki, listNative = taskView && taskKey(taskView.ref) === key ? taskView.nativeWiki : undefined;
  const newerListNative = !!listNative && (!detailNative || listNative.revision > detailNative.revision || listNative.revision === detailNative.revision && (taskView?.updatedAt ?? 0) > (readDetail?.updatedAt ?? 0));
  const nativeWiki = newerListNative ? listNative : detailNative;
  const knowledge = (detail as (TaskDetail & { knowledge?: RepoWikiKnowledgeSnapshot }) | undefined)?.knowledge;
  const knowledgeView = knowledge ? projectKnowledge(knowledge) : undefined;
  const currentDocument = knowledgeView ? knowledgeView.currentItem : detail?.currentPage;
  const valid = (request: number) => request === epoch.current && session === currentSession.current && visible && !!selected;

  useEffect(() => { if (preview) previewCard.current?.scrollIntoView?.({ block: 'nearest' }); }, [preview]);

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
      if (result.callsModel && (!result.model || latest.resource?.type !== 'repoWiki' && result.targetCount === undefined)) throw new Error('无法确认模型或处理范围，请重新读取');
      setDetail(latest);
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

  const cancel = async () => {
    if (!selected || busyRef.current || !visible) return;
    const stable = selected; const request = epoch.current;
    busyRef.current = true; setBusy(true); setMutationError(undefined);
    try {
      const latest = await agentDataApi.tasks.read(stable);
      if (!valid(request)) return;
      if (!latest || latest.ref.source !== 'user' || !latest.capabilities.cancel) throw new Error('当前不允许取消此任务，请刷新后重试');
      await agentDataApi.jobs.cancel(stable.id);
      await onRefresh?.();
      // 取消后重读详情，让事件时间线与执行摘要跟上。
      if (valid(request)) setLoadRequest((value) => value + 1);
    } catch (cause) { if (valid(request)) setMutationError(message(cause)); }
    finally { if (valid(request)) { busyRef.current = false; setBusy(false); } }
  };

  const retry = async () => {
    if (!preview || !selected || taskKey(preview.ref) !== key || busyRef.current || !visible) return;
    const stable = preview; const request = epoch.current;
    busyRef.current = true; setBusy(true); setMutationError(undefined);
    try {
      const result = await agentDataApi.tasks.retry(stable.ref, stable.callsModel ? { expectedModel: stable.model,
        ...(stable.modelIdentity !== undefined ? { expectedModelIdentity: stable.modelIdentity } : {}),
        ...(stable.planToken !== undefined ? { expectedPlanToken: stable.planToken } : {}),
      } : undefined);
      if (!valid(request)) return;
      setNewTask(result.ref); setPreview(undefined);
      onTrack?.(result.ref);
      await onRefresh?.();
    } catch (cause) { if (valid(request)) setMutationError(message(cause)); }
    finally { if (valid(request)) { busyRef.current = false; setBusy(false); } }
  };

  const summaries = [
    detail?.inputSummary ? { key: 'input', label: '输入摘要', children: <pre>{JSON.stringify(redact(detail.inputSummary), null, 2)}</pre> } : null,
    detail?.outputSummary ? { key: 'output', label: '结果摘要', children: <pre>{JSON.stringify(redact(detail.outputSummary), null, 2)}</pre> } : null,
  ].filter(Boolean) as { key: string; label: string; children: ReactNode }[];

  return <Drawer open={visible && !!selected} title="任务详情" extra={detail?.ref.source === 'user' ? <Space size={8}>{detail.capabilities.cancel && !detail.cancellationRequested ? <Button disabled={busy} onClick={() => void cancel()}>取消任务</Button> : null}<Button disabled={busy || !detail.capabilities.retry} onClick={() => void prepareRetry()}>重试任务</Button></Space> : null} size="min(560px, 100vw)" closable={!busy} keyboard={!busy} maskClosable={!busy}
    onClose={() => { if (!busyRef.current) onClose(); }} styles={{ wrapper: { maxWidth: '100vw' }, header: { padding: '16px clamp(16px, 3vw, 24px)' }, body: { minWidth: 0, padding: '20px clamp(16px, 3vw, 24px) 32px' } }}>
    <Space orientation="vertical" size={20} style={{ width: '100%' }}>
      {loading ? <Typography.Text type="secondary">正在读取任务详情…</Typography.Text> : null}
      {readError ? <Alert type="error" showIcon title={<Flex justify="space-between" align="center" gap={12}><span>{readError}</span><Button size="small" onClick={() => setLoadRequest((value) => value + 1)}>重新读取</Button></Flex>} /> : null}
      {!loading && !readError && !detail ? <Typography.Text type="secondary">任务记录已移除</Typography.Text> : null}
      {detail ? <>
        <Flex justify="space-between" align="flex-start" gap={16}>
          <div><Typography.Text type="secondary">任务详情</Typography.Text><Typography.Title level={4} style={{ margin: 0 }}>{detail.label}</Typography.Title></div>
          <Tag color={taskStatusColors[detail.status]}>{detail.cancellationRequested ? '正在取消' : taskStatusLabels[detail.status]}</Tag>
        </Flex>
        {detail.error ? <PageBanner type="error" items={[{ message: String(redact(detail.error)) }]}
          action={detail.resource && onNavigate ? <Button size="small" disabled={busy} onClick={() => onNavigate(resourceNavigation(detail.resource!))}>查看关联资源</Button> : undefined} /> : null}
        <section aria-labelledby="task-info-heading">
          <Typography.Title level={5} id="task-info-heading">任务信息</Typography.Title>
          <Descriptions column={1} size="small" items={[
            { key: 'kind', label: '类型', children: detail.kind },
            { key: 'id', label: 'ID', children: detail.ref.id },
            { key: 'source', label: '来源', children: detail.ref.source === 'system' ? '系统后台（只读）' : '用户任务' },
            { key: 'created', label: '创建时间', children: new Date(detail.createdAt).toLocaleString() },
            { key: 'updated', label: '更新时间', children: new Date(detail.updatedAt).toLocaleString() },
          ]} />
        </section>
        <section aria-labelledby="task-resource-heading">
          <Typography.Title level={5} id="task-resource-heading">资源信息</Typography.Title>
          <Descriptions column={1} size="small" items={[
            { key: 'target', label: '目标', children: resourceTarget(detail) },
            { key: 'workspace', label: '工作区', children: detail.workspace || '—' },
          ]} />
          {detail.resource && onNavigate && !detail.error ? <Button disabled={busy} onClick={() => onNavigate(resourceNavigation(detail.resource!))}>查看关联资源</Button> : null}
        </section>
        <section aria-labelledby="task-execution-heading">
          <Typography.Title level={5} id="task-execution-heading">执行摘要</Typography.Title>
          {nativeWiki && <Descriptions data-testid="task-native-wiki-summary" column={1} size="small" items={[
            { key: 'engine', label: '执行引擎', children: nativeWiki.engine },
            { key: 'operation', label: '操作 ID', children: nativeWiki.operationId },
            { key: 'revision', label: '操作版本', children: nativeWiki.revision },
            ...(nativeWiki.publication ? [
              { key: 'publicationId', label: '发布 ID', children: nativeWiki.publication.id },
              { key: 'coverage', label: '覆盖状态', children: nativeWiki.publication.coverage.partial ? '部分覆盖' : '完整覆盖' },
              { key: 'published', label: '本次发布', children: `${nativeWiki.publication.coverage.published} 篇` },
              { key: 'readable', label: '可读正文', children: `${nativeWiki.publication.coverage.readable} 篇` },
              { key: 'failed', label: '失败条目', children: `${nativeWiki.publication.coverage.failed.length} 项` },
              { key: 'projection', label: '文件投影', children: ({ pending: '待投影', ready: '已投影', conflict: '存在冲突', error: '投影失败' } as const)[nativeWiki.publication.projection.status] },
            ] : [{ key: 'publication', label: '正式发布', children: '尚无正式发布' }]),
          ]} />}
          {knowledge && <Descriptions data-testid="task-knowledge-summary" column={1} size="small" items={[
            { key: 'revision', label: '任务版本', children: knowledge.run?.revision },
            { key: 'phase', label: '知识构建阶段', children: projectKnowledge(knowledge).phaseLabel },
            { key: 'prepared', label: '已准备', children: projectKnowledge(knowledge).preparedLabel },
            ...(knowledge.run?.error ? [{ key: 'error', label: '原因', children: knowledgeErrorText(knowledge.run.error) }] : []),
            { key: 'published', label: '正式发布', children: knowledge.content.publishedCount },
            { key: 'failed', label: '失败 / 依赖阻塞', children: `${knowledge.run?.counts.failed ?? 0} / ${knowledge.run?.counts.blocked ?? 0}` },
          ]} />}
          {knowledgeView && <KnowledgeActiveItems view={knowledgeView} />}
          <Descriptions column={1} size="small" items={[
            { key: 'status', label: '状态', children: detail.cancellationRequested ? '正在取消，等待确认' : taskStatusLabels[detail.status] },
            { key: 'stage', label: '阶段', children: detail.stage || '未提供阶段' },
            ...(detail.message ? [{ key: 'message', label: '当前操作', children: String(redact(detail.message)) }] : []),
            ...(!knowledgeView?.activeLabel && currentDocument ? [{ key: 'page', label: '当前文档', children: currentDocument }] : []),
            { key: 'progress', label: '进度', children: detail.progress === undefined || !Number.isFinite(detail.progress) ? '未提供百分比' : `${detail.progress}%` },
            { key: 'count', label: '处理数量', children: detail.processed === undefined && detail.total === undefined ? '未提供计数' : `${detail.processed ?? '—'} / ${detail.total ?? '—'}` },
            { key: 'attempts', label: '尝试次数', children: detail.attempts ?? '未提供' },
            ...(detail.retryOf ? [{ key: 'retryOf', label: '重试来源', children: detail.retryOf }] : []),
          ]} />
          {summaries.length ? <Collapse size="small" ghost defaultActiveKey={summaries.map((item) => item.key)} items={summaries} /> : null}
        </section>
        <section aria-labelledby="task-events-heading">
          <Typography.Title level={5} id="task-events-heading">任务事件</Typography.Title>
          {detail.events.length === 0 ? <Typography.Text type="secondary">暂无任务事件</Typography.Text> : <Timeline items={detail.events.map((event) => ({
            key: event.id,
            content: <><div>{String(redact(event.message))}</div><Typography.Text type="secondary">{event.action} · {new Date(event.createdAt).toLocaleString()}</Typography.Text></>,
          }))} />}
        </section>
      </> : null}
      {mutationError ? <Alert type="error" showIcon title={mutationError} /> : null}
      {preview ? <Card ref={previewCard} size="small" title="重试确认">
        <Space orientation="vertical" size={8} style={{ width: '100%' }}>
          <p>新建任务，保留旧记录。旧任务的失败状态和审计历史不会更改。</p>
          {preview.callsModel ? <><p>将调用模型：<strong>{preview.model}</strong></p>{detail?.resource?.type === 'repoWiki'
            ? <p>将为工作区 {detail.workspace || detail.resource.id}（语言：{detail.resource.language || (typeof detail.inputSummary?.language === 'string' ? detail.inputSummary.language : '默认')}）重新生成 {detail.inputSummary?.target === 'cards' ? '知识卡片' : 'Wiki 文档'}，可能产生模型费用。</p>
            : <p>本次处理 {preview.targetCount} 份来源，可能产生模型费用。</p>}</> : <p>此任务不调用模型。</p>}
          {preview.reusable !== undefined || preview.redo !== undefined ? <p>可复用 {preview.reusable ?? 0} 项，重做 {preview.redo ?? 0} 项。</p> : null}
          <Space size={8} wrap>
            <Button disabled={busy} onClick={() => setPreview(undefined)}>取消重试</Button>
            <Button disabled={busy} onClick={() => void prepareRetry()}>重新读取重试范围</Button>
            <Button disabled={busy} onClick={() => void retry()}>确认重试</Button>
          </Space>
        </Space>
      </Card> : null}
      {newTask ? <Typography.Text>已创建新任务 <Button disabled={busy} onClick={() => { onSelect?.(newTask); setLocalRef(newTask); }}>查看新任务（{newTask.id}）</Button></Typography.Text> : null}
    </Space>
  </Drawer>;
}
