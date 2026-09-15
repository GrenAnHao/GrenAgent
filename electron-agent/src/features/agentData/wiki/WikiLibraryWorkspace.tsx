import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Alert, Button, Drawer, Dropdown, Input, Modal, Tag } from 'antd';
import { Ellipsis, Info, RefreshCw } from 'lucide-react';
import { agentDataApi } from '../../../lib/agentData';
import { openPath, revealItemInDir } from '../../../platform/runtime';
import type { WikiIngestPreview, WikiLibraryView, WikiPage, WikiReindexResult, WikiSource, WikiTarget } from '../../../../electron/agentData/wikiContracts';
import { useAgentDataTaskMonitor } from '../AgentDataTaskProvider';
import { useProjectOptions } from '../useProjectOptions';
import { styles } from '../agentDataStyles';
import { taskStatusLabels } from '../operationsPresentation';
import { LazyMarkdown } from '../../chat/LazyMarkdown';
import { WikiLibraryDialog } from './WikiLibraryDialog';
import { WikiSourceDialog } from './WikiSourceDialog';
import { WikiDeleteDialog, wikiTargetKey } from './WikiDeleteDialog';
import { WikiPageEditor, type WikiPageEditorHandle } from './WikiPageEditor';
import { wikiStyles as w } from './wikiStyles';

interface Props { visible: boolean; confirmationVisible?: boolean; kbId: string; navigationPageId?: string; navigationMode?: 'read' | 'create'; navigationRequest?: number; onBack(): void; onViewTask?(id: string): void; onDeleted?(kbId: string): void }
export interface WikiLibraryWorkspaceHandle { confirmLeave(): Promise<boolean> }
const jobLabels = { pending: '等待中', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消' };
const sourceLabels = { pending: '待抽取', processing: '抽取中', succeeded: '已抽取', failed: '抽取失败' };
const lifecycleLabels = { active: '正常', deleting: '删除中', deleted: '已删除' };

export const WikiLibraryWorkspace = forwardRef<WikiLibraryWorkspaceHandle, Props>(function WikiLibraryWorkspace({ visible, confirmationVisible = visible, kbId, navigationPageId, navigationMode, navigationRequest = 0, onBack, onViewTask, onDeleted }, ref) {
  const monitor = useAgentDataTaskMonitor();
  const projects = useProjectOptions();
  const [library, setLibrary] = useState<WikiLibraryView>();
  const [sources, setSources] = useState<WikiSource[]>([]);
  const [pages, setPages] = useState<Array<Omit<WikiPage, 'content'>>>([]);
  const [sourcesLoaded, setSourcesLoaded] = useState(false);
  const [pagesLoaded, setPagesLoaded] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'sources' | 'pages'>('sources');
  const [sourceQuery, setSourceQuery] = useState('');
  const [pageQuery, setPageQuery] = useState('');
  const [selectedSourceId, setSelectedSourceId] = useState<string>();
  const [selectedPageId, setSelectedPageId] = useState<string>();
  const [sourceDetail, setSourceDetail] = useState<{ source: WikiSource; content: string }>();
  const [selectedPage, setSelectedPage] = useState<WikiPage>();
  const [showPage, setShowPage] = useState(false);
  const [newPageVersion, setNewPageVersion] = useState(0);
  const [detailVersion, setDetailVersion] = useState(0);
  const [libraryDialog, setLibraryDialog] = useState(false);
  const [sourceDialog, setSourceDialog] = useState<{ source?: WikiSource }>();
  const [deleteTarget, setDeleteTarget] = useState<WikiTarget>();
  const [properties, setProperties] = useState(false);
  const [ingestDialog, setIngestDialog] = useState<{ kbId: string; regenerateSourceIds?: string[] }>();
  const [ingestPreview, setIngestPreview] = useState<WikiIngestPreview>();
  const [ingestError, setIngestError] = useState<string>();
  const [ingesting, setIngesting] = useState(false);
  const [reindexDialog, setReindexDialog] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [reindexResult, setReindexResult] = useState<WikiReindexResult>();
  const [activeJobId, setActiveJobId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const requestSequence = useRef(0);
  const pageSequence = useRef(0);
  const selectionSequence = useRef(0);
  const handledNavigation = useRef<string | undefined>(undefined);
  const navigationKey = JSON.stringify([kbId, navigationPageId, navigationMode, navigationRequest]);
  const ingestSequence = useRef(0);
  const editor = useRef<WikiPageEditorHandle>(null);
  const pageTrigger = useRef<HTMLElement | null>(null);
  const sourceTrigger = useRef<HTMLButtonElement | null>(null);
  const pendingListFocus = useRef<HTMLElement | null>(null);
  const mounted = useRef(true);
  const currentKb = useRef(kbId);
  const currentVisible = useRef(visible);
  currentKb.current = kbId;
  currentVisible.current = visible;
  const readOnly = !library || library.lifecycle !== 'active' || deleting || unavailable;
  useImperativeHandle(ref, () => ({ confirmLeave: () => { selectionSequence.current++; return editor.current?.confirmDiscard() ?? Promise.resolve(true); } }));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    pendingListFocus.current = null;
    setLibrary(undefined); setSources([]); setPages([]); setErrors({}); setSelectedSourceId(undefined); setSelectedPageId(undefined);
    setSourcesLoaded(false); setPagesLoaded(false); setUnavailable(false);
    setSourceDetail(undefined); setSelectedPage(undefined); setShowPage(false); setActiveJobId(undefined); setNotice(undefined);
    setIngestDialog(undefined); setIngestPreview(undefined); setReindexResult(undefined); setDeleting(false); setTab('sources');
    setSourceQuery(''); setPageQuery('');
    return () => { requestSequence.current++; pageSequence.current++; ingestSequence.current++; };
  }, [kbId]);
  useEffect(() => {
    const detailOpen = tab === 'sources' ? !!selectedSourceId : showPage;
    if (!visible || detailOpen || !pendingListFocus.current) return;
    const target = pendingListFocus.current;
    pendingListFocus.current = null;
    if (target.isConnected) target.focus();
  }, [visible, tab, selectedSourceId, showPage]);
  const reload = useCallback(async () => {
    if (!visible || !currentVisible.current || currentKb.current !== kbId) return;
    const request = ++requestSequence.current;
    setLoading(true);
    const results = await Promise.allSettled([
      agentDataApi.wiki.libraries.read(kbId), agentDataApi.wiki.sources.list(kbId), agentDataApi.wiki.pages.list(kbId),
    ]);
    if (requestSequence.current !== request) return;
    if (results[0].status === 'rejected' && String(results[0].reason).includes('NOT_FOUND')) {
      setUnavailable(true); setLoading(false); pageSequence.current++;
      setLibrary((current) => current ? { ...current, lifecycle: 'deleted', activeJobId: undefined, deletingTargets: [] } : current);
      setSources([]); setPages([]); setSelectedSourceId(undefined); setSourceDetail(undefined);
      setErrors({});
      if (!editor.current?.isDirty()) {
        setSelectedPageId(undefined); setSelectedPage(undefined); setShowPage(false);
        if (onDeleted) onDeleted(kbId); else onBack();
      }
      return;
    }
    const nextErrors: Record<string, string> = {};
    if (results[0].status === 'fulfilled') { setLibrary(results[0].value); setUnavailable(false); setDeleting(results[0].value.lifecycle !== 'active'); }
    else nextErrors['知识库'] = String(results[0].reason);
    if (results[1].status === 'fulfilled') {
      setSources(results[1].value);
      setSourcesLoaded(true);
      setSelectedSourceId((id) => id && results[1].status === 'fulfilled' && !results[1].value.some((item) => item.sourceId === id) ? undefined : id);
    } else nextErrors['原始资料'] = String(results[1].reason);
    if (results[2].status === 'fulfilled') { setPages(results[2].value); setPagesLoaded(true); }
    else nextErrors['知识页面'] = String(results[2].reason);
    setErrors(nextErrors); setLoading(false); setDetailVersion((value) => value + 1);
  }, [kbId, visible]);
  useEffect(() => { void reload(); return () => { requestSequence.current++; }; }, [reload, monitor.watchedTaskVersion]);
  useEffect(() => {
    if (visible && library?.activeJobId) monitor.track(library.activeJobId);
  }, [visible, library?.activeJobId, monitor.track]);
  useEffect(() => {
    if (!visible || !selectedSourceId) { if (!selectedSourceId) setSourceDetail(undefined); return; }
    let cancelled = false;
    void agentDataApi.wiki.sources.read(kbId, selectedSourceId)
      .then((result) => { if (!cancelled) { setSourceDetail(result); setErrors((current) => { const next = { ...current }; delete next['资料正文']; return next; }); } })
      .catch((cause) => { if (!cancelled) setErrors((current) => ({ ...current, 资料正文: String(cause) })); });
    return () => { cancelled = true; };
  }, [visible, kbId, selectedSourceId, detailVersion]);
  useEffect(() => {
    const request = ++pageSequence.current;
    if (!visible || !selectedPageId || unavailable) return;
    void agentDataApi.wiki.pages.read(kbId, selectedPageId).then((result) => {
      if (request !== pageSequence.current) return;
      if (result) { setSelectedPage(result); setShowPage(true); }
      else if (editor.current?.isDirty()) setErrors((current) => ({ ...current, 页面正文: '页面已被删除；未保存草稿仍保留。' }));
      else { setShowPage(false); setSelectedPageId(undefined); setSelectedPage(undefined); }
    }).catch((cause) => { if (request === pageSequence.current) setErrors((current) => ({ ...current, 页面正文: String(cause) })); });
    return () => { pageSequence.current++; };
  }, [visible, kbId, selectedPageId, detailVersion, unavailable]);

  const back = async () => {
    if (unavailable) {
      if (!await (editor.current?.confirmDiscard() ?? Promise.resolve(true))) return;
      if (onDeleted) onDeleted(kbId); else onBack();
    } else onBack();
  };
  const requestDelete = async (target: WikiTarget) => {
    if (target.kind === 'library') {
      if (!await (editor.current?.confirmDiscard() ?? Promise.resolve(true))) return;
      setShowPage(false); setSelectedPageId(undefined); setSelectedPage(undefined);
    }
    setDeleteTarget(target);
  };
  const deletionWaiting = (target: WikiTarget) => {
    setLibrary((current) => {
      if (!current) return current;
      const targets = current.deletingTargets ?? [];
      return { ...current, deletingTargets: [...targets.filter((item) => wikiTargetKey(item) !== wikiTargetKey(target)), target] };
    });
    if (target.kind === 'library') setDeleting(true);
    void reload();
  };
  const deletionCompleted = (target: WikiTarget) => {
    if (target.kind === 'library') { if (onDeleted) onDeleted(target.kbId); else onBack(); }
    else {
      if (target.kind === 'source') setSelectedSourceId((id) => id === target.sourceId ? undefined : id);
      if (target.kind === 'page' && selectedPageId === target.pageId) { setShowPage(false); setSelectedPageId(undefined); setSelectedPage(undefined); }
      setLibrary((current) => current ? { ...current, deletingTargets: current.deletingTargets?.filter((item) => wikiTargetKey(item) !== wikiTargetKey(target)) } : current);
      void reload();
    }
  };

  const choosePage = async (id: string | undefined, trigger?: HTMLElement) => {
    const request = ++selectionSequence.current;
    if (id && id === selectedPageId) { setTab('pages'); return; }
    if (!await (editor.current?.confirmDiscard() ?? Promise.resolve(true))) return;
    if (request !== selectionSequence.current || !mounted.current || !currentVisible.current || currentKb.current !== kbId) return;
    pageSequence.current++; pageTrigger.current = trigger ?? null;
    setTab('pages'); setSelectedPage(undefined); setSelectedPageId(id); setShowPage(!id);
    if (!id) setNewPageVersion((value) => value + 1);
    if (!trigger) setPageQuery('');
  };
  const navigationReady = !!navigationPageId || !!library;
  useEffect(() => {
    if (!visible || !navigationReady || handledNavigation.current === navigationKey || !navigationPageId && navigationMode !== 'create') return;
    handledNavigation.current = navigationKey;
    if (!navigationPageId && readOnly) return;
    let settled = false;
    void choosePage(navigationPageId).finally(() => { settled = true; });
    return () => {
      selectionSequence.current++;
      if (!settled && currentVisible.current && handledNavigation.current === navigationKey) handledNavigation.current = undefined;
    };
  }, [navigationKey, visible, navigationReady]);
  const closePage = () => { pendingListFocus.current = pageTrigger.current; setShowPage(false); setSelectedPageId(undefined); setSelectedPage(undefined); void reload(); };
  const prepareIngest = async (regenerateSourceIds?: string[]) => {
    if (readOnly || !visible || ingesting) return;
    const request = ++ingestSequence.current;
    setIngestDialog({ kbId, regenerateSourceIds }); setIngestPreview(undefined); setIngestError(undefined);
    try {
      const preview = await agentDataApi.wiki.libraries.previewIngest(kbId, undefined, regenerateSourceIds);
      if (ingestSequence.current === request) setIngestPreview(preview);
    } catch (cause) { if (ingestSequence.current === request) setIngestError(String(cause)); }
  };
  const confirmIngest = async () => {
    if (!ingestDialog || !ingestPreview || ingesting || readOnly || !ingestPreview.targetCount) return;
    const target = ingestDialog;
    const trackCreated = monitor.track;
    setIngesting(true); setIngestError(undefined);
    try {
      const receipt = await agentDataApi.wiki.libraries.ingest(target.kbId, ingestPreview.sourceIds, target.regenerateSourceIds, ingestPreview.model);
      trackCreated(receipt.jobId);
      if (mounted.current && currentKb.current === target.kbId) { setActiveJobId(receipt.jobId); setNotice('已加入任务'); setIngestDialog(undefined); }
    } catch (cause) { if (mounted.current && currentKb.current === target.kbId) setIngestError(String(cause)); }
    finally { if (mounted.current) setIngesting(false); }
  };
  const reindex = async () => {
    if (readOnly || reindexing) return;
    setReindexing(true);
    try {
      const result = await agentDataApi.wiki.libraries.reindex(kbId);
      setReindexResult(result); setReindexDialog(false); void reload();
    } catch (cause) { setErrors((current) => ({ ...current, 索引: String(cause) })); }
    finally { setReindexing(false); }
  };
  const reportPathError = (cause: unknown) => setErrors((current) => ({ ...current, 打开位置: String(cause) }));
  const jobId = activeJobId ?? library?.activeJobId;
  const job = monitor.jobs.find((item) => item.id === jobId);
  const jobLabel = job?.state === 'cancelled' && library?.activeJobId === jobId
    ? '正在取消 · 等待任务收尾'
    : job ? jobLabels[job.state] : '任务状态未获取';
  const task = monitor.tasks?.find((item) => item.ref.source === 'user' && item.ref.id === jobId);
  let taskSummary = job ? `${jobLabel} · ${job.progress}%${job.error ? ` · ${job.error}` : ''}` : jobLabel;
  if (task) {
    const progress = typeof task.progress === 'number' ? `${task.progress}%` : task.stage || '进度未提供';
    let label = taskStatusLabels[task.status];
    if (task.cancellationRequested) label = '正在取消 · 等待确认';
    else if (task.status === 'cancelled' && library?.activeJobId === jobId) label = '正在取消 · 等待任务收尾';
    taskSummary = `${label} · ${progress}${task.error ? ` · ${task.error}` : ''}`;
  }
  const projectNames = library?.bindings.map((cwd) => projects.find((item) => item.cwd === cwd)?.name ?? cwd).join('、') || '未关联项目';
  const propertiesContent = <><h4>知识库属性</h4><p>关联项目：{projectNames}</p><p>{library?.sourceCount ?? sources.length} 份资料 · {library?.pageCount ?? pages.length} 个页面</p><p>{library?.pendingSourceCount ?? 0} 份待抽取</p><p>状态：{library ? lifecycleLabels[library.lifecycle] : '未获取'}</p>{library?.location ? <><p>{library.location}</p><Button onClick={() => { void openPath(library.location).catch(reportPathError); }}>打开存储位置</Button></> : null}</>;

  return <section hidden={!visible} className={w.root} data-testid="wiki-library-workspace">
    <header className={w.header}>
      <div>
        <div className={w.headerTitle}>
          <Button onClick={() => void back()} aria-label="返回知识库列表" size="small">← 知识库列表</Button>
          <h3>{library?.name ?? '知识库'}</h3>
        </div>
        {library?.description ? <p>{library.description}</p> : null}
        <div className={w.headerMeta}>
          <span>{library?.sourceCount ?? sources.length} 份资料</span>
          <span>{library?.pageCount ?? pages.length} 个页面</span>
          <span>{library?.pendingSourceCount ?? 0} 份待抽取</span>
          <span>状态：{library ? lifecycleLabels[library.lifecycle] : '未获取'}</span>
        </div>
      </div>
      <div className={w.toolbar}>
        <Button aria-label="刷新当前知识库" disabled={loading} icon={<RefreshCw size={14} />} onClick={() => void reload()} />
        <Button className={w.propertyButton} aria-label="查看知识库属性" icon={<Info size={14} />} onClick={() => setProperties(true)} />
        <Button type="primary" disabled={readOnly || !sources.some((item) => item.lifecycle === 'active') || ingesting} onClick={() => void prepareIngest()}>开始抽取</Button>
        <Dropdown trigger={['click']} menu={{ items: [{ key: 'properties', label: '知识库属性', disabled: readOnly }, { key: 'reindex', label: '重建索引', disabled: readOnly }, { key: 'delete', label: '删除知识库', danger: true, disabled: !library || unavailable }], onClick: ({ key }) => { if (key === 'properties') setLibraryDialog(true); if (key === 'reindex') setReindexDialog(true); if (key === 'delete') void requestDelete({ kind: 'library', kbId }); } }}><Button aria-label="知识库更多操作" icon={<Ellipsis size={16} />} /></Dropdown>
      </div>
    </header>
    {Object.entries(errors).map(([domain, error]) => <Alert key={domain} type="error" title={`${domain}：${error}`} showIcon />)}
    {unavailable ? <Alert type="warning" title="知识库已删除；草稿保留可复制。" /> : readOnly && library ? <Alert type="warning" title="知识库正在删除，等待任务结束；内容仍可查看。" /> : null}
    {library?.deletingTargets?.length ? <Alert type="warning" title="待完成的删除" description={<div className={w.toolbar}>{library.deletingTargets.map((target) => {
      const label = target.kind === 'library' ? `知识库 ${library.name}` : target.kind === 'source' ? `资料 ${target.sourceId}` : `页面 ${target.pageId}`;
      return <Button key={wikiTargetKey(target)} aria-label={`继续删除${label}`} onClick={() => void requestDelete(target)}>继续删除{label}</Button>;
    })}</div>} /> : null}
    {jobId ? <div className={w.toolbar} role="status">{notice ? <span>{notice}</span> : null}<span>任务 {jobId}</span><Tag>{taskSummary}</Tag><Button onClick={() => onViewTask?.(jobId)} disabled={!onViewTask}>查看任务</Button></div> : null}
    {jobId && monitor.error ? <Alert type="error" title={`任务状态刷新失败：${monitor.error}`} /> : null}
    {reindexResult ? <div className={w.diagnostics} role="status"><p>索引扫描：{reindexResult.pages} 个页面{reindexResult.diagnostics.length ? '；索引保留，正文读取异常' : '；重建完成'}</p>{reindexResult.diagnostics.map((item, index) => <div key={index}><p>{item.code} · {item.message}</p><p>{item.path}</p><Button size="small" onClick={() => { void revealItemInDir(item.path).catch(reportPathError); }}>打开问题文件位置</Button></div>)}</div> : null}
    {!library && loading ? <p role="status">正在加载知识库…</p> : null}
    <div className={w.tabs} role="tablist" aria-label="知识库内容"><Button role="tab" aria-selected={tab === 'sources'} onClick={() => setTab('sources')}>原始资料 ({sourcesLoaded ? sources.length : '未获取'})</Button><Button role="tab" aria-selected={tab === 'pages'} onClick={() => setTab('pages')}>知识页面 ({pagesLoaded ? pages.length : '未获取'})</Button></div>
    <div className={w.workspace} data-detail={tab === 'sources' ? !!selectedSourceId : showPage}>
      <aside className={w.sidebar} data-wiki-list>
        <div className={w.sidebarActions}>
          <Button disabled={readOnly} onClick={() => setSourceDialog({})} size="small" block>添加资料</Button>
          <Button disabled={readOnly} onClick={(event) => void choosePage(undefined, event.currentTarget)} size="small" block>新建页面</Button>
        </div>
        <div hidden={tab !== 'sources'}>
          <Input aria-label="搜索原始资料" placeholder="搜索资料" value={sourceQuery} onChange={(event) => setSourceQuery(event.target.value)} size="small" />
          <div className={w.resourceList} aria-label="原始资料列表">
            {sources.filter((item) => `${item.name} ${item.projectWorkspace ?? ''}`.toLowerCase().includes(sourceQuery.toLowerCase())).map((item) => <button type="button" key={item.sourceId} className={w.resource} aria-label={`查看资料 ${item.name}`} aria-pressed={selectedSourceId === item.sourceId} onClick={(event) => { sourceTrigger.current = event.currentTarget; if (selectedSourceId !== item.sourceId) setSourceDetail(undefined); setSelectedSourceId(item.sourceId); }}>{item.name}<small>{sourceLabels[item.status]} · r{item.revision}{item.projectWorkspace ? ` · ${item.projectWorkspace}` : ''}</small></button>)}
          </div>
          {sourcesLoaded && !sources.length && !loading && !unavailable ? <p className={w.muted}>添加原始资料后可开始抽取。</p> : null}
          {!sourcesLoaded && !loading ? <p className={w.muted}>原始资料尚未获取</p> : null}
        </div>
        <div hidden={tab !== 'pages'}>
          <Input aria-label="搜索知识页面" placeholder="搜索页面" value={pageQuery} onChange={(event) => setPageQuery(event.target.value)} size="small" />
          <div className={w.resourceList} aria-label="知识页面列表">
            {pages.filter((item) => item.title.toLowerCase().includes(pageQuery.toLowerCase())).map((item) => <button type="button" key={item.pageId} className={w.resource} aria-label={`查看页面 ${item.title}`} aria-pressed={selectedPageId === item.pageId} onClick={(event) => void choosePage(item.pageId, event.currentTarget)}>{item.title}<small>{item.locked ? '人工锁定' : '未声明人工锁定'} · r{item.revision}</small></button>)}
          </div>
          {pagesLoaded && !pages.length && !loading && !unavailable ? <p className={w.muted}>还没有知识页面。</p> : null}
          {!pagesLoaded && !loading ? <p className={w.muted}>知识页面尚未获取</p> : null}
        </div>
      </aside>
      <div className={w.detail} data-wiki-detail>
        <div hidden={tab !== 'sources'}>{sourceDetail ? <>
          <Button aria-label="关闭资料详情" onClick={() => { pendingListFocus.current = sourceTrigger.current; setSelectedSourceId(undefined); }} size="small">← 返回资料列表</Button>
          <h3>{sourceDetail.source.name}</h3>
          <p className={w.muted}>{sourceDetail.source.kind} · r{sourceDetail.source.revision} · {sourceLabels[sourceDetail.source.status]}{sourceDetail.source.lifecycle === 'deleted' ? ' · 来源已删除' : ''}</p>
          {sourceDetail.source.projectWorkspace ? <p className={w.muted}>{sourceDetail.source.projectWorkspace} / {sourceDetail.source.relativePath}</p> : null}
          {sourceDetail.source.error ? <Alert type="error" title={sourceDetail.source.error} /> : null}
          <div className={w.toolbar}><Button disabled={readOnly || sourceDetail.source.lifecycle !== 'active'} onClick={() => setSourceDialog({ source: sourceDetail.source })}>更新这份资料</Button><Button disabled={readOnly || sourceDetail.source.lifecycle !== 'active'} onClick={() => void prepareIngest([sourceDetail.source.sourceId])}>重新生成页面</Button><Button danger disabled={readOnly} onClick={() => setDeleteTarget({ kind: 'source', kbId, sourceId: sourceDetail.source.sourceId })}>删除资料</Button></div>
          {sourceDetail.source.generationSuppressed ? <p className={w.muted}>页面已删除，普通抽取不会恢复；可显式重新生成。</p> : null}
          <div className={w.document}><LazyMarkdown prose={false}>{sourceDetail.content}</LazyMarkdown></div>
        </> : <div className={w.emptyState}>{selectedSourceId ? '正在读取资料…' : '选择原始资料查看内容和版本'}</div>}</div>
        <div hidden={tab !== 'pages'}>{showPage ? <WikiPageEditor ref={editor} key={`${kbId}:${selectedPageId ?? `new:${newPageVersion}`}`} kbId={kbId} page={selectedPage} readOnly={readOnly} visible={visible} confirmationVisible={confirmationVisible} onDeleteRequested={setDeleteTarget} onSaved={(saved) => { setSelectedPage(saved); setSelectedPageId(saved.pageId); setShowPage(true); void reload(); }} onClose={closePage} /> : <div className={w.emptyState}>{selectedPageId ? '正在读取页面…' : '选择知识页面，或新建人工页面'}</div>}</div>
      </div>
    </div>
    <Drawer open={visible && properties} title="知识库属性" onClose={() => setProperties(false)}>{propertiesContent}</Drawer>
    <WikiLibraryDialog open={libraryDialog} visible={visible} library={library} onClose={() => setLibraryDialog(false)} onSaved={(saved) => { setLibrary(saved); setLibraryDialog(false); void reload(); }} />
    <WikiSourceDialog open={!!sourceDialog} visible={visible} kbId={kbId} bindings={library?.bindings ?? []} source={sourceDialog?.source} onClose={() => setSourceDialog(undefined)} onSaved={() => void reload()} />
    <WikiDeleteDialog target={visible ? deleteTarget : undefined} onClose={() => setDeleteTarget(undefined)} onWaiting={deletionWaiting} onDeleted={deletionCompleted} />
    <Modal open={visible && !!ingestDialog} title={ingestDialog?.regenerateSourceIds ? '重新生成页面确认' : '开始抽取确认'} onCancel={() => { if (!ingesting) { ingestSequence.current++; setIngestDialog(undefined); } }} onOk={() => void confirmIngest()} okText={`确认抽取 ${ingestPreview?.targetCount ?? 0} 份资料`} cancelText="取消" confirmLoading={ingesting} okButtonProps={{ disabled: !ingestPreview || !ingestPreview.targetCount || !!ingestError || readOnly }}>
      <p>会调用模型</p>{ingestPreview ? <><p>{ingestPreview.model}</p><p>本次处理 {ingestPreview.targetCount} 份资料</p></> : !ingestError ? <p>正在读取资料范围与实际模型…</p> : null}
      {ingestDialog?.regenerateSourceIds ? <p>将明确允许恢复被删除的生成页面；人工锁定与多来源页面仍受保护。</p> : null}{ingestError ? <Alert type="error" title={ingestError} /> : null}
    </Modal>
    <Modal open={visible && reindexDialog} title="重建索引" onCancel={() => setReindexDialog(false)} onOk={() => void reindex()} okText="确认重建索引" cancelText="取消" confirmLoading={reindexing} okButtonProps={{ disabled: readOnly }}><p>不调用模型，不改正文</p><p>只重新读取 Markdown 并更新检索索引，诊断异常时保留现有内容。</p></Modal>
  </section>;
});
