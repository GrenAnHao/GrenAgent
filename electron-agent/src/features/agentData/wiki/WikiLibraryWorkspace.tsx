import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Alert, Button, Drawer, Dropdown, Input, Modal, Tag } from 'antd';
import { Ellipsis, Info, RefreshCw } from 'lucide-react';
import { agentDataApi, type WikiAssetDetail, type WikiRawSource, type WikiSearchHit } from '../../../lib/agentData';
import { openPath } from '../../../platform/runtime';
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
}
export interface WikiLibraryWorkspaceHandle { confirmLeave(): Promise<boolean> }

const statusLabels: Record<string, string> = {
  draft: '草稿', pending: '待抽取', processing: '处理中', ready: '可用', failed: '失败',
};
const rawLabels: Record<string, string> = {
  uploaded: '已上传', ingested: '已抽取', failed: '抽取失败',
};

type PageSummary = { id: string; title: string; type: string; relPath: string };

export const WikiLibraryWorkspace = forwardRef<WikiLibraryWorkspaceHandle, Props>(function WikiLibraryWorkspace({
  visible, confirmationVisible = visible, kbId, navigationPageId, navigationMode, navigationRequest = 0, onBack, onDeleted,
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
  const [properties, setProperties] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [ingestNotice, setIngestNotice] = useState<string>();
  const [resetting, setResetting] = useState(false);
  const requestSequence = useRef(0);
  const pageSequence = useRef(0);
  const editor = useRef<WikiPageEditorHandle>(null);
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

  useEffect(() => { void reload(); return () => { requestSequence.current++; }; }, [reload]);

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
  const propertiesContent = <><h4>知识库属性</h4><p>{library?.pageCount ?? pages.length} 个页面 · {sources.length} 份原文</p><p>状态：{library ? statusLabels[library.status] ?? library.status : '未获取'}</p>{library?.dir ? <><p>{library.dir}</p><Button onClick={() => { void openPath(library.dir).catch(reportPathError); }}>打开存储位置</Button></> : null}</>;

  return <section hidden={!visible} className={w.root} data-testid="wiki-library-workspace">
    <header className={w.header}>
      <div>
        <div className={w.headerTitle}>
          <Button onClick={() => onBack()} aria-label="返回知识库列表" size="small">← 知识库列表</Button>
          <h3>{library?.name ?? '知识库'}</h3>
        </div>
        {library?.summary ? <p>{library.summary}</p> : null}
        <div className={w.headerMeta}>
          <span>{sources.length} 份资料</span>
          <span>{library?.pageCount ?? pages.length} 个页面</span>
          <span>状态：{library ? statusLabels[library.status] ?? library.status : '未获取'}</span>
          {busy ? <Tag color="processing" data-testid="wiki-busy-tag">处理中</Tag> : null}
        </div>
      </div>
      <div className={w.toolbar}>
        <Button aria-label="刷新当前知识库" disabled={loading} icon={<RefreshCw size={14} />} onClick={() => void reload()} />
        <Button className={w.propertyButton} aria-label="查看知识库属性" icon={<Info size={14} />} onClick={() => setProperties(true)} />
        <Button type="primary" disabled={readOnly || !sources.length || ingesting} onClick={() => void startIngest()}>{ingesting || library?.status === 'processing' ? '处理中' : '开始抽取'}</Button>
        <Button disabled={!canReset || resetting} autoInsertSpace={false} onClick={() => void resetDraft()}>重置状态</Button>
        <Dropdown trigger={['click']} menu={{ items: [
          { key: 'properties', label: '知识库属性' },
          { key: 'delete', label: '删除知识库', danger: true, disabled: !library || unavailable },
        ], onClick: ({ key }) => { if (key === 'properties') setLibraryDialog(true); if (key === 'delete') { setConfirmName(''); setDeleteOpen(true); } } }}><Button aria-label="知识库更多操作" icon={<Ellipsis size={16} />} /></Dropdown>
      </div>
    </header>
    {Object.entries(errors).map(([domain, error]) => <Alert key={domain} type="error" title={`${domain}：${error}`} showIcon />)}
    {ingestNotice ? <Alert type="info" title={ingestNotice} data-testid="wiki-ingest-notice" /> : null}
    {unavailable ? <Alert type="warning" title="知识库已删除。" /> : null}
    {!library && loading ? <p role="status">正在加载知识库…</p> : null}
    <div className={w.tabs} role="tablist" aria-label="知识库内容">
      <Button role="tab" type={tab === 'sources' ? 'primary' : 'text'} aria-selected={tab === 'sources'} onClick={() => setTab('sources')}>原始资料 ({sourcesLoaded ? sources.length : '未获取'})</Button>
      <Button role="tab" type={tab === 'pages' ? 'primary' : 'text'} aria-selected={tab === 'pages'} onClick={() => setTab('pages')}>知识页面 ({pagesLoaded ? pages.length : '未获取'})</Button>
      <Button role="tab" type={tab === 'templates' ? 'primary' : 'text'} aria-selected={tab === 'templates'} onClick={() => setTab('templates')}>抽取模板</Button>
      <Button role="tab" type={tab === 'search' ? 'primary' : 'text'} aria-selected={tab === 'search'} onClick={() => setTab('search')}>检索与图谱</Button>
    </div>
    <div className={w.workspace} data-detail={tab === 'sources' ? !!selectedSource : showPage}>
      <aside className={w.sidebar} data-wiki-list>
        <div className={w.sidebarActions}>
          <Button disabled={readOnly || library?.status === 'processing'} onClick={() => setSourceDialog(true)} size="small" block aria-label="上传原文">上传原文</Button>
        </div>
        <div hidden={tab !== 'sources'}>
          <Input aria-label="搜索原始资料" placeholder="搜索资料" value={sourceQuery} onChange={(event) => setSourceQuery(event.target.value)} size="small" />
          <div className={w.resourceList} aria-label="原始资料列表">
            {sources.filter((item) => item.filename.toLowerCase().includes(sourceQuery.toLowerCase())).map((item) => <Button key={item.filename} block className={w.resource} aria-label={`查看资料 ${item.filename}`} aria-pressed={selectedSource === item.filename} onClick={() => setSelectedSource(item.filename)}>{item.filename}<small>{rawLabels[item.status] ?? item.status}</small></Button>)}
          </div>
          {sourcesLoaded && !sources.length && !loading ? <p className={w.muted}>上传原文后可开始抽取。</p> : null}
        </div>
        <div hidden={tab !== 'pages'}>
          <Input aria-label="搜索知识页面" placeholder="搜索页面" value={pageQuery} onChange={(event) => setPageQuery(event.target.value)} size="small" />
          <div className={w.resourceList} aria-label="知识页面列表">
            {pages.filter((item) => item.title.toLowerCase().includes(pageQuery.toLowerCase())).map((item) => <Button key={item.id} block className={w.resource} aria-label={`查看页面 ${item.title}`} aria-pressed={selectedPageId === item.id} onClick={() => { setSelectedPageId(item.id); setShowPage(true); }}>{item.title}<small>{item.type}</small></Button>)}
          </div>
          {pagesLoaded && !pages.length && !loading ? <p className={w.muted}>还没有知识页面。</p> : null}
        </div>
        <div hidden={tab !== 'templates'}>
          <p className={w.muted}>编辑 purpose.md / schema.md，不走页面锁定写入。</p>
        </div>
        <div hidden={tab !== 'search'}>
          <p className={w.muted}>图谱边：{graphEdges.length}</p>
        </div>
      </aside>
      <div className={w.detail} data-wiki-detail>
        <div hidden={tab !== 'sources'}>{selectedSource ? <>
          <Button aria-label="关闭资料详情" onClick={() => setSelectedSource(undefined)} size="small">← 返回资料列表</Button>
          <h3>{selectedSource}</h3>
          <div className={w.toolbar}>
            <Button danger disabled={readOnly || library?.status === 'processing'} onClick={() => void agentDataApi.wiki.rawRemove(kbId, selectedSource).then(() => { setSelectedSource(undefined); void reload(); }).catch((cause) => setErrors((current) => ({ ...current, 删除资料: String(cause) })))}>删除资料</Button>
          </div>
          <div className={w.document}><LazyMarkdown prose={false}>{sourceContent ?? '正在读取资料…'}</LazyMarkdown></div>
        </> : <div className={w.emptyState}>选择原始资料查看内容</div>}</div>
        <div hidden={tab !== 'pages'}>{showPage && selectedPageId ? <WikiPageEditor ref={editor} key={`${kbId}:${selectedPageId}`} wikiId={kbId} pageId={selectedPageId} title={pages.find((item) => item.id === selectedPageId)?.title ?? selectedPageId} content={selectedPageContent} readOnly={readOnly} visible={visible} confirmationVisible={confirmationVisible} onSaved={() => void reload()} onClose={() => { setShowPage(false); setSelectedPageId(undefined); setSelectedPageContent(undefined); }} onDeleted={() => { setShowPage(false); setSelectedPageId(undefined); void reload(); }} /> : <div className={w.emptyState}>选择知识页面</div>}</div>
        <div hidden={tab !== 'templates'}>
          <label className={w.field}>purpose.md
            <Input.TextArea aria-label="purpose.md" rows={8} value={purposeDraft} disabled={readOnly} onChange={(event) => setPurposeDraft(event.target.value)} />
          </label>
          <Button type="primary" disabled={readOnly} loading={savingTemplate === 'purpose'} onClick={() => void saveTemplate('purpose')}>保存 purpose.md</Button>
          <label className={w.field}>schema.md
            <Input.TextArea aria-label="schema.md" rows={8} value={schemaDraft} disabled={readOnly} onChange={(event) => setSchemaDraft(event.target.value)} />
          </label>
          <Button disabled={readOnly} loading={savingTemplate === 'schema'} onClick={() => void saveTemplate('schema')}>保存 schema.md</Button>
        </div>
        <div hidden={tab !== 'search'}>
          <div className={w.toolbar}>
            <Input aria-label="检索知识库" placeholder="输入检索词" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
            <Button type="primary" loading={searching} aria-label="执行检索" autoInsertSpace={false} onClick={() => void runSearch()}>检索</Button>
          </div>
          <div className={w.resourceList} aria-label="检索结果">
            {searchHits.map((hit) => <Button key={`${hit.path}:${hit.score}`} block className={w.resource} onClick={() => { setTab('pages'); setSelectedPageId(hit.path.replace(/^wiki\//, '').replace(/\.md$/, '')); setShowPage(true); }}>{hit.title}<small>{hit.snippet}</small></Button>)}
          </div>
          {!searchHits.length ? <p className={w.muted}>输入关键词后检索。</p> : null}
        </div>
      </div>
    </div>
    <Drawer open={visible && properties} title="知识库属性" onClose={() => setProperties(false)}>{propertiesContent}</Drawer>
    <WikiLibraryDialog open={libraryDialog} visible={visible} library={library} onClose={() => setLibraryDialog(false)} onSaved={(saved) => { setLibrary(saved); setLibraryDialog(false); void reload(); }} />
    <WikiSourceDialog open={sourceDialog} visible={visible} wikiId={kbId} disabled={readOnly || library?.status === 'processing'} onClose={() => setSourceDialog(false)} onSaved={() => void reload()} />
    <Modal open={visible && deleteOpen} title="确认删除知识库" closable={!deleting} keyboard={!deleting} onCancel={() => { if (!deleting) setDeleteOpen(false); }} onOk={() => void confirmDelete()} okText="确认删除" cancelText="取消" confirmLoading={deleting} okButtonProps={{ danger: true, disabled: !library || confirmName !== library.name, autoInsertSpace: false }}>
      <p>删除后不可恢复。输入知识库名称确认。</p>
      <Input aria-label="输入知识库名称确认" value={confirmName} onChange={(event) => setConfirmName(event.target.value)} />
    </Modal>
  </section>;
});
