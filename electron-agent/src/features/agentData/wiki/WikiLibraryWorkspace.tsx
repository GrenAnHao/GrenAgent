import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Alert, Button, Input, Modal, Segmented, Tag } from 'antd';
import { agentDataApi, type WikiAssetDetail, type WikiRawSource, type WikiSearchHit } from '../../../lib/agentData';
import { openPath } from '../../../platform/runtime';
import { PageHeader } from '../workbench/PageHeader';
import { PageBanner } from '../workbench/PageBanner';
import { MoreMenu } from '../workbench/MoreMenu';
import { SplitPane } from '../workbench/SplitPane';
import { workbenchStyles as s } from '../workbench/workbenchStyles';
import { useAskConfirm } from '../../../components/askConfirm';
import { StatusTag } from '../workbench/StatusTag';
import { LazyMarkdown } from '../../chat/LazyMarkdown';
import { WikiLibraryDialog } from './WikiLibraryDialog';
import { WikiSourceDialog } from './WikiSourceDialog';
import { WikiPageEditor, type WikiPageEditorHandle } from './WikiPageEditor';
import { wikiStyles as w } from './wikiStyles';

interface Props {
  visible: boolean;
  confirmationVisible?: boolean;
  kbId: string;
  navigationPageId?: string;
  navigationMode?: 'read' | 'create';
  navigationRequest?: number;
  onBack(): void;
  onViewTask?(id: string): void;
  onDeleted?(wikiId: string): void;
  refreshToken?: number;
}
export interface WikiLibraryWorkspaceHandle { confirmLeave(): Promise<boolean> }

const rawLabels: Record<string, string> = {
  uploaded: '已上传', ingested: '已抽取', failed: '抽取失败',
};
const stageLabels: Record<string, string> = {
  scanning: '扫描原文', ingesting: '抽取页面', 'rebuilding-index': '重建索引',
};

type PageSummary = { id: string; title: string; type: string; relPath: string };

export const WikiLibraryWorkspace = forwardRef<WikiLibraryWorkspaceHandle, Props>(function WikiLibraryWorkspace({
  visible, confirmationVisible = visible, kbId, navigationPageId, navigationMode, navigationRequest = 0, onBack, onDeleted, refreshToken,
}, ref) {
  const [library, setLibrary] = useState<WikiAssetDetail>();
  const [sources, setSources] = useState<WikiRawSource[]>([]);
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [sourcesLoaded, setSourcesLoaded] = useState(false);
  const [pagesLoaded, setPagesLoaded] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'sources' | 'pages' | 'templates' | 'search'>('sources');
  const [sourceQuery, setSourceQuery] = useState('');
  const [pageQuery, setPageQuery] = useState('');
  const [selectedSource, setSelectedSource] = useState<string>();
  const [sourceContent, setSourceContent] = useState<string>();
  const [selectedPageId, setSelectedPageId] = useState<string>();
  const [selectedPageContent, setSelectedPageContent] = useState<string>();
  const [showPage, setShowPage] = useState(false);
  const [editingPage, setEditingPage] = useState(false);
  const [pageDeleteOpen, setPageDeleteOpen] = useState(false);
  const [purposeDraft, setPurposeDraft] = useState('');
  const [schemaDraft, setSchemaDraft] = useState('');
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState<'purpose' | 'schema'>();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHits, setSearchHits] = useState<WikiSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [graphEdges, setGraphEdges] = useState<Array<{ source_id: string; target_id: string }>>([]);
  const [libraryDialog, setLibraryDialog] = useState(false);
  const [sourceDialog, setSourceDialog] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [ingestNotice, setIngestNotice] = useState<string>();
  const [resetting, setResetting] = useState(false);
  const requestSequence = useRef(0);
  const pageSequence = useRef(0);
  const editor = useRef<WikiPageEditorHandle>(null);
  const ask = useAskConfirm();
  const mounted = useRef(true);
  const currentKb = useRef(kbId);
  const currentVisible = useRef(visible);
  currentKb.current = kbId;
  currentVisible.current = visible;

  const busy = library?.status === 'processing' || ingesting;
  const canReset = library?.status === 'pending' || library?.status === 'processing';
  const readOnly = unavailable || busy;

  useImperativeHandle(ref, () => ({ confirmLeave: () => editor.current?.confirmDiscard() ?? Promise.resolve(true) }));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    setLibrary(undefined); setSources([]); setPages([]); setErrors({}); setSelectedSource(undefined); setSelectedPageId(undefined);
    setSourcesLoaded(false); setPagesLoaded(false); setUnavailable(false); setSourceContent(undefined); setSelectedPageContent(undefined);
    setShowPage(false); setTemplatesLoaded(false); setPurposeDraft(''); setSchemaDraft(''); setSearchHits([]); setGraphEdges([]);
    setEditingPage(false); setPageDeleteOpen(false);
    setIngestNotice(undefined); setTab('sources'); setSourceQuery(''); setPageQuery(''); setSearchQuery('');
    return () => { requestSequence.current++; pageSequence.current++; };
  }, [kbId]);

  const reload = useCallback(async () => {
    if (!visible || !currentVisible.current || currentKb.current !== kbId) return;
    const request = ++requestSequence.current;
    setLoading(true);
    const results = await Promise.allSettled([
      agentDataApi.wiki.read(kbId),
      agentDataApi.wiki.rawList(kbId),
      agentDataApi.wiki.pageList(kbId),
      agentDataApi.wiki.graph(kbId),
    ]);
    if (requestSequence.current !== request) return;
    if (results[0].status === 'rejected' && String(results[0].reason).includes('not_found')) {
      setUnavailable(true); setLoading(false);
      if (onDeleted) onDeleted(kbId); else onBack();
      return;
    }
    const nextErrors: Record<string, string> = {};
    if (results[0].status === 'fulfilled') { setLibrary(results[0].value); setUnavailable(false); }
    else nextErrors['知识库'] = String(results[0].reason);
    if (results[1].status === 'fulfilled') { setSources(results[1].value); setSourcesLoaded(true); }
    else nextErrors['原始资料'] = String(results[1].reason);
    if (results[2].status === 'fulfilled') { setPages(results[2].value); setPagesLoaded(true); }
    else nextErrors['知识页面'] = String(results[2].reason);
    if (results[3].status === 'fulfilled') setGraphEdges(results[3].value);
    setErrors(nextErrors); setLoading(false);
  }, [kbId, visible, onBack, onDeleted]);

  useEffect(() => { void reload(); return () => { requestSequence.current++; }; }, [reload, refreshToken]);

  // 处理中每 2 秒重读一次；用 pollTick 驱动下一轮，避免后端返回相同 version/updatedAt 时轮询停摆。
  const [pollTick, setPollTick] = useState(0);
  useEffect(() => {
    if (!visible || library?.status !== 'processing' || ingesting) return;
    const timer = setTimeout(() => { void reload().finally(() => setPollTick((value) => value + 1)); }, 2000);
    return () => clearTimeout(timer);
  }, [visible, library?.status, ingesting, reload, pollTick]);

  useEffect(() => {
    if (!visible || !selectedSource) { if (!selectedSource) setSourceContent(undefined); return; }
    let cancelled = false;
    void agentDataApi.wiki.rawRead(kbId, selectedSource)
      .then((content) => { if (!cancelled) setSourceContent(content); })
      .catch((cause) => { if (!cancelled) setErrors((current) => ({ ...current, 资料正文: String(cause) })); });
    return () => { cancelled = true; };
  }, [visible, kbId, selectedSource]);

  useEffect(() => {
    const request = ++pageSequence.current;
    if (!visible || !selectedPageId || unavailable) return;
    void agentDataApi.wiki.pageRead(kbId, selectedPageId).then((content) => {
      if (request !== pageSequence.current) return;
      setSelectedPageContent(content);
      setShowPage(true);
      setEditingPage(false);
    }).catch((cause) => {
      if (request === pageSequence.current) setErrors((current) => ({ ...current, 页面正文: String(cause) }));
    });
    return () => { pageSequence.current++; };
  }, [visible, kbId, selectedPageId, unavailable]);

  useEffect(() => {
    if (!visible || tab !== 'templates' || templatesLoaded) return;
    let cancelled = false;
    void Promise.all([
      agentDataApi.wiki.pageRead(kbId, 'purpose').catch(() => ''),
      agentDataApi.wiki.pageRead(kbId, 'schema').catch(() => ''),
    ]).then(([purpose, schema]) => {
      if (cancelled) return;
      setPurposeDraft(purpose);
      setSchemaDraft(schema);
      setTemplatesLoaded(true);
    });
    return () => { cancelled = true; };
  }, [visible, tab, kbId, templatesLoaded]);

  useEffect(() => {
    if (!visible || !navigationPageId && navigationMode !== 'create') return;
    if (navigationPageId) { setTab('pages'); setSelectedPageId(navigationPageId); setShowPage(true); }
  }, [visible, navigationPageId, navigationMode, navigationRequest]);

  const startIngest = async () => {
    if (readOnly || !library || ingesting) return;
    setIngesting(true); setIngestNotice(undefined);
    try {
      const result = await agentDataApi.wiki.ingest(kbId);
      if (result.kind === 'busy') setIngestNotice(`处理中（${result.status}${result.step ? ` · ${result.step}` : ''}）`);
      else setIngestNotice('抽取完成');
      await reload();
    } catch (cause) { setErrors((current) => ({ ...current, 抽取: String(cause) })); }
    finally { if (mounted.current) setIngesting(false); }
  };

  const resetDraft = async () => {
    if (!canReset || resetting) return;
    setResetting(true);
    try {
      await agentDataApi.wiki.resetDraft(kbId);
      setIngestNotice('已重置为草稿');
      await reload();
    } catch (cause) { setErrors((current) => ({ ...current, 重置: String(cause) })); }
    finally { setResetting(false); }
  };

  const saveTemplate = async (name: 'purpose' | 'schema') => {
    if (readOnly || savingTemplate) return;
    setSavingTemplate(name);
    try {
      await agentDataApi.wiki.writeTemplate(kbId, name, name === 'purpose' ? purposeDraft : schemaDraft);
      setIngestNotice(`已保存 ${name}.md`);
    } catch (cause) { setErrors((current) => ({ ...current, 模板: String(cause) })); }
    finally { setSavingTemplate(undefined); }
  };

  const runSearch = async () => {
    if (!searchQuery.trim() || searching) return;
    setSearching(true);
    try {
      const result = await agentDataApi.wiki.search(kbId, searchQuery.trim());
      setSearchHits(result.results);
    } catch (cause) { setErrors((current) => ({ ...current, 检索: String(cause) })); }
    finally { setSearching(false); }
  };

  const confirmDelete = async () => {
    if (!library || deleting || confirmName !== library.name) return;
    setDeleting(true);
    try {
      await agentDataApi.wiki.remove(kbId);
      setDeleteOpen(false);
      if (onDeleted) onDeleted(kbId); else onBack();
    } catch (cause) { setErrors((current) => ({ ...current, 删除: String(cause) })); }
    finally { setDeleting(false); }
  };

  const reportPathError = (cause: unknown) => setErrors((current) => ({ ...current, 打开位置: String(cause) }));

  const closePage = async () => {
    if (editingPage && !(await (editor.current?.confirmDiscard() ?? Promise.resolve(true)))) return;
    setShowPage(false); setSelectedPageId(undefined); setSelectedPageContent(undefined); setEditingPage(false);
  };
  const pageMenu = <MoreMenu label="页面更多操作" items={[{ key: 'delete', label: '删除页面', danger: true, disabled: readOnly }]} onSelect={(key) => { if (key === 'delete') setPageDeleteOpen(true); }} />;

  return <section hidden={!visible} className={w.root} data-testid="wiki-library-workspace">
    <PageHeader
      title={<nav aria-label="面包屑"><Button type="link" className={w.crumb} aria-label="返回知识库列表" onClick={() => onBack()}>知识库</Button> / {library?.name ?? '知识库'}</nav>}
      extra={library ? <StatusTag domain="wiki" status={library.status} /> : null}
      subtitle={`${sourcesLoaded ? sources.length : '未获取'} 份资料 · ${library?.pageCount ?? pages.length} 页`}
      actions={<>
        <Button type="primary" autoInsertSpace={false} disabled={readOnly || !sources.length || ingesting} onClick={() => void startIngest()}>{busy ? '抽取中…' : '开始抽取'}</Button>
        <MoreMenu label="知识库更多操作" items={[
          { key: 'props', label: '编辑属性' },
          { key: 'open', label: '打开存储位置', disabled: !library?.dir },
          { key: 'reset', label: '重置为草稿', disabled: !canReset || resetting },
          { key: 'delete', label: '删除知识库', danger: true, disabled: !library || unavailable },
        ]} onSelect={(key) => {
          if (key === 'props') setLibraryDialog(true);
          if (key === 'open' && library?.dir) void openPath(library.dir).catch(reportPathError);
          if (key === 'reset') void resetDraft();
          if (key === 'delete') { setConfirmName(''); setDeleteOpen(true); }
        }} />
      </>} />
    {library?.status === 'processing' ? <PageBanner type="info" items={[{ message: `正在抽取，完成前内容只读${library.internalStatus ? ` · ${stageLabels[library.internalStatus] ?? library.internalStatus}` : ''}` }]} /> : null}
    {library?.status === 'failed' && library.syncError ? <PageBanner type="error" items={[{ source: '抽取失败', message: library.syncError }]} /> : null}
    <PageBanner type="error" items={Object.entries(errors).map(([source, message]) => ({ source, message }))} />
    {ingestNotice ? <Alert type="info" title={ingestNotice} data-testid="wiki-ingest-notice" /> : null}
    {unavailable ? <Alert type="warning" title="知识库已删除。" /> : null}
    {library?.summary ? <p className={w.muted}>{library.summary}</p> : null}
    {!library && loading ? <p role="status">正在加载知识库…</p> : null}
    <div className={s.panelToolbar}>
      <Segmented value={tab} onChange={(value) => setTab(value as typeof tab)} options={[
        { value: 'sources', label: `原始资料 (${sourcesLoaded ? sources.length : '未获取'})` },
        { value: 'pages', label: `知识页面 (${pagesLoaded ? pages.length : '未获取'})` },
        { value: 'templates', label: '抽取模板' },
        { value: 'search', label: '检索' },
      ]} />
      <span className={s.spacer} />
      {tab === 'sources' ? <Input aria-label="搜索原始资料" placeholder="搜索资料" value={sourceQuery} onChange={(event) => setSourceQuery(event.target.value)} size="small" style={{ width: 200 }} /> : null}
      {tab === 'pages' ? <Input aria-label="搜索知识页面" placeholder="搜索页面" value={pageQuery} onChange={(event) => setPageQuery(event.target.value)} size="small" style={{ width: 200 }} /> : null}
      {tab === 'sources' ? <Button size="small" disabled={readOnly || library?.status === 'processing'} onClick={() => setSourceDialog(true)} aria-label="上传原文">上传原文</Button> : null}
    </div>
    <div hidden={tab !== 'sources'}>
      <SplitPane detailOpen={!!selectedSource}
        side={<>
          <div className={w.resourceList} aria-label="原始资料列表">
            {sources.filter((item) => item.filename.toLowerCase().includes(sourceQuery.toLowerCase())).map((item) => <Button key={item.filename} block className={w.resource} aria-label={`查看资料 ${item.filename}`} aria-pressed={selectedSource === item.filename} onClick={() => setSelectedSource(item.filename)}>{item.filename}<small>{rawLabels[item.status] ?? item.status}</small></Button>)}
          </div>
          {sourcesLoaded && !sources.length && !loading ? <p className={w.muted}>上传原文后可开始抽取。</p> : null}
        </>}
        main={selectedSource ? <>
          <div className={s.detailHeader}>
            <Button className={w.back} aria-label="关闭资料详情" onClick={() => setSelectedSource(undefined)} size="small">←</Button>
            <h3>{selectedSource}</h3><span className={s.spacer} />
            <Button danger autoInsertSpace={false} disabled={readOnly || library?.status === 'processing'} onClick={async () => { if (await ask({ title: `删除资料 ${selectedSource}？`, content: '删除后需要重新上传。', danger: true })) void agentDataApi.wiki.rawRemove(kbId, selectedSource).then(() => { setSelectedSource(undefined); void reload(); }).catch((cause) => setErrors((current) => ({ ...current, 删除资料: String(cause) }))); }}>删除资料</Button>
          </div>
          <div className={w.document}><LazyMarkdown prose={false}>{sourceContent ?? '正在读取资料…'}</LazyMarkdown></div>
        </> : <div className={w.emptyState}>选择原始资料查看内容</div>} />
    </div>
    <div hidden={tab !== 'pages'}>
      <SplitPane detailOpen={showPage}
        side={<>
          <div className={w.resourceList} aria-label="知识页面列表">
            {pages.filter((item) => item.title.toLowerCase().includes(pageQuery.toLowerCase())).map((item) => <Button key={item.id} block className={w.resource} aria-label={`查看页面 ${item.title}`} aria-pressed={selectedPageId === item.id} onClick={() => { setSelectedPageId(item.id); setShowPage(true); }}>{item.title}<small>{item.type}</small></Button>)}
          </div>
          {pagesLoaded && !pages.length && !loading ? <p className={w.muted}>还没有知识页面。</p> : null}
        </>}
        main={showPage && selectedPageId ? <>
          {editingPage
            ? <WikiPageEditor ref={editor} key={`${kbId}:${selectedPageId}`} wikiId={kbId} pageId={selectedPageId} title={pages.find((item) => item.id === selectedPageId)?.title ?? selectedPageId} content={selectedPageContent} readOnly={readOnly} visible={visible} confirmationVisible={confirmationVisible} onSaved={() => { setEditingPage(false); void reload(); }} onClose={() => setEditingPage(false)} />
            : <>
              <div className={s.detailHeader}>
                <Button className={w.back} aria-label="关闭页面详情" onClick={() => void closePage()} size="small">←</Button>
                <h3>{pages.find((item) => item.id === selectedPageId)?.title ?? selectedPageId}</h3>
                <Tag>{pages.find((item) => item.id === selectedPageId)?.type ?? '页面'}</Tag>
                <span className={s.spacer} />
                <Button disabled={readOnly} onClick={() => setEditingPage(true)}>编辑页面</Button>
                {pageMenu}
              </div>
              <div className={w.document}><LazyMarkdown prose={false}>{selectedPageContent ?? '正在读取页面…'}</LazyMarkdown></div>
            </>}
          {/* 编辑中也保留删除入口：编辑器自身不再带删除按钮。 */}
          {editingPage ? <div className={s.detailHeader}><span className={s.spacer} />{pageMenu}</div> : null}
          <Modal open={pageDeleteOpen} title="确认删除页面" okText="确认删除" cancelText="取消" okButtonProps={{ danger: true, autoInsertSpace: false }} onCancel={() => setPageDeleteOpen(false)} onOk={() => void agentDataApi.wiki.pageRemove(kbId, selectedPageId).then(() => { setPageDeleteOpen(false); setEditingPage(false); setShowPage(false); setSelectedPageId(undefined); setSelectedPageContent(undefined); void reload(); }).catch((cause) => setErrors((current) => ({ ...current, 删除页面: String(cause) })))}>
            <p>删除后不可恢复。</p>
          </Modal>
        </> : <div className={w.emptyState}>选择知识页面</div>} />
    </div>
    <div className={w.detail} hidden={tab !== 'templates'}>
      <div className={w.templateGrid}>
        <div className={w.templateCol}>
          <label className={w.field}>purpose.md<small className={w.muted}>这个库用来做什么</small>
            <Input.TextArea aria-label="purpose.md" rows={12} value={purposeDraft} disabled={readOnly} onChange={(event) => setPurposeDraft(event.target.value)} />
          </label>
          <Button type="primary" disabled={readOnly} loading={savingTemplate === 'purpose'} onClick={() => void saveTemplate('purpose')}>保存 purpose.md</Button>
        </div>
        <div className={w.templateCol}>
          <label className={w.field}>schema.md<small className={w.muted}>抽取出哪些页面类型</small>
            <Input.TextArea aria-label="schema.md" rows={12} value={schemaDraft} disabled={readOnly} onChange={(event) => setSchemaDraft(event.target.value)} />
          </label>
          <Button disabled={readOnly} loading={savingTemplate === 'schema'} onClick={() => void saveTemplate('schema')}>保存 schema.md</Button>
        </div>
      </div>
    </div>
    <div className={w.detail} hidden={tab !== 'search'}>
      <div className={w.toolbar}>
        <Input aria-label="检索知识库" placeholder="输入检索词" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
        <Button type="primary" loading={searching} aria-label="执行检索" autoInsertSpace={false} onClick={() => void runSearch()}>检索</Button>
      </div>
      <div className={w.resourceList} aria-label="检索结果">
        {searchHits.map((hit) => <Button key={`${hit.path}:${hit.score}`} block className={w.resource} onClick={() => { setTab('pages'); setSelectedPageId(hit.path.replace(/^wiki\//, '').replace(/\.md$/, '')); setShowPage(true); }}>{hit.title}<small>{hit.snippet}</small></Button>)}
      </div>
      {!searchHits.length ? <p className={w.muted}>图谱共 {graphEdges.length} 条边</p> : null}
    </div>
    <WikiLibraryDialog open={libraryDialog} visible={visible} library={library} onClose={() => setLibraryDialog(false)} onSaved={(saved) => { setLibrary(saved); setLibraryDialog(false); void reload(); }} />
    <WikiSourceDialog open={sourceDialog} visible={visible} wikiId={kbId} disabled={readOnly || library?.status === 'processing'} onClose={() => setSourceDialog(false)} onSaved={() => void reload()} />
    <Modal open={visible && deleteOpen} title="确认删除知识库" closable={!deleting} keyboard={!deleting} onCancel={() => { if (!deleting) setDeleteOpen(false); }} onOk={() => void confirmDelete()} okText="确认删除" cancelText="取消" confirmLoading={deleting} okButtonProps={{ danger: true, disabled: !library || confirmName !== library.name, autoInsertSpace: false }}>
      <p>删除后不可恢复。输入知识库名称确认。</p>
      <Input aria-label="输入知识库名称确认" value={confirmName} onChange={(event) => setConfirmName(event.target.value)} />
    </Modal>
  </section>;
});
