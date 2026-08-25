import { Alert, Button, Checkbox, Empty, Input, InputNumber, Modal, Popconfirm, Select, Spin, Tag } from 'antd';
import { Flexbox } from '@lobehub/ui';
import { BookOpen, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  tencentdbApi,
  type TencentdbCodeGraph,
  type TencentdbCodeGraphFilesFormat,
  type TencentdbCodeGraphQueryResponse,
  type TencentdbKnowledgeAssets,
  type TencentdbWiki,
  type TencentdbWikiPage,
  type TencentdbWikiPageContent,
  type TencentdbWikiSearchResponse,
} from './tencentdbApi';

type KnowledgeKind = 'wiki' | 'codegraph';
type SelectedAsset = { id: string; label: string };
type Notice = { type: 'error' | 'success' | 'info'; text: string };
type CodeGraphAction = 'search' | 'explore' | 'callers' | 'callees' | 'impact' | 'node' | 'status' | 'files';

interface KnowledgeManagerProps {
  kind: KnowledgeKind;
  enabled: boolean;
  workspace?: string;
}

const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const isBuilding = (status: string) => status === 'pending' || status === 'processing';
const codeGraphActions: Array<{ value: CodeGraphAction; label: string }> = [
  { value: 'search', label: '搜索符号' },
  { value: 'explore', label: '探索代码' },
  { value: 'callers', label: '查找调用方' },
  { value: 'callees', label: '查找被调用方' },
  { value: 'impact', label: '影响分析' },
  { value: 'node', label: '节点详情' },
  { value: 'status', label: '索引状态' },
  { value: 'files', label: '文件列表' },
];

export function KnowledgeManager({ kind, enabled, workspace }: KnowledgeManagerProps) {
  const [knowledge, setKnowledge] = useState<TencentdbKnowledgeAssets | null>(null);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selected, setSelected] = useState<SelectedAsset | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [wikiPages, setWikiPages] = useState<TencentdbWikiPage[]>([]);
  const [wikiSearch, setWikiSearch] = useState<TencentdbWikiSearchResponse | null>(null);
  const [pageContent, setPageContent] = useState<TencentdbWikiPageContent | null>(null);
  const [codeGraphResult, setCodeGraphResult] = useState<TencentdbCodeGraphQueryResponse | null>(null);
  const [codeGraphAction, setCodeGraphAction] = useState<CodeGraphAction>('search');
  const [queryLimit, setQueryLimit] = useState(20);
  const [nodeFile, setNodeFile] = useState('');
  const [nodeLine, setNodeLine] = useState<number | null>(null);
  const [includeCode, setIncludeCode] = useState(false);
  const [filesPath, setFilesPath] = useState('');
  const [filesPattern, setFilesPattern] = useState('');
  const [filesFormat, setFilesFormat] = useState<TencentdbCodeGraphFilesFormat>('tree');
  const [includeMetadata, setIncludeMetadata] = useState(true);
  const [maxDepth, setMaxDepth] = useState<number | null>(null);
  const reloadGeneration = useRef(0);
  const scopeKey = `${enabled ? 'enabled' : 'disabled'}\u0000${kind}\u0000${workspace ?? ''}`;
  const scope = useRef(scopeKey);
  scope.current = scopeKey;

  const reload = useCallback(async (quiet = false) => {
    if (!enabled) return;
    const requestScope = scopeKey;
    const generation = ++reloadGeneration.current;
    const isCurrent = () => (
      reloadGeneration.current === generation
      && scope.current === requestScope
    );
    if (!quiet) setLoading(true);
    try {
      const nextKnowledge = await tencentdbApi.listKnowledgeAssets(workspace);
      if (!isCurrent()) return;
      setKnowledge(nextKnowledge);
      setLoadedScope(requestScope);
      if (!quiet) setNotice(null);
    } catch (cause) {
      if (!isCurrent()) return;
      setNotice({ type: 'error', text: errorMessage(cause) });
    } finally {
      if (isCurrent() && !quiet) setLoading(false);
    }
  }, [enabled, scopeKey, workspace]);

  useEffect(() => {
    setSelected(null);
    setNotice(null);
    setDetailLoading(false);
    setWikiPages([]);
    setWikiSearch(null);
    setPageContent(null);
    setCodeGraphResult(null);
    if (!enabled) {
      reloadGeneration.current += 1;
      setKnowledge(null);
      setLoadedScope(null);
      setLoading(false);
      return;
    }
    void reload();
    return () => {
      reloadGeneration.current += 1;
    };
  }, [enabled, reload]);

  const scopedKnowledge = loadedScope === scopeKey ? knowledge : null;
  const isCurrentScope = (value: string) => scope.current === value;
  const rows = useMemo(
    () => kind === 'wiki' ? scopedKnowledge?.wikis ?? [] : scopedKnowledge?.codeGraphs ?? [],
    [kind, scopedKnowledge],
  );
  const buildingAssetIds = rows
    .filter((row) => isBuilding(row.status))
    .map((row) => kind === 'wiki' ? (row as TencentdbWiki).wiki_id : (row as TencentdbCodeGraph).code_graph_id);
  const buildingAssetKey = buildingAssetIds.join('\u0000');
  const hasBuildingAsset = buildingAssetIds.length > 0;

  useEffect(() => {
    if (!enabled || !hasBuildingAsset) return;
    const pollScope = scopeKey;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      const results = await Promise.allSettled(buildingAssetIds.map((id) => (
        kind === 'wiki' ? tencentdbApi.getWiki(id) : tencentdbApi.getCodeGraph(id)
      )));
      if (cancelled || scope.current !== pollScope) return;
      const updates = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
      if (updates.length > 0) {
        setKnowledge((current) => {
          if (!current) return current;
          if (kind === 'wiki') {
            const byId = new Map((updates as TencentdbWiki[]).map((item) => [item.wiki_id, item]));
            return { ...current, wikis: current.wikis.map((item) => byId.get(item.wiki_id) ?? item) };
          }
          const byId = new Map((updates as TencentdbCodeGraph[]).map((item) => [item.code_graph_id, item]));
          return { ...current, codeGraphs: current.codeGraphs.map((item) => byId.get(item.code_graph_id) ?? item) };
        });
      }
      const shouldContinue = results.some((result) => (
        result.status === 'rejected' || isBuilding(result.value.status)
      ));
      if (shouldContinue) timer = window.setTimeout(() => void poll(), 2000);
    };
    timer = window.setTimeout(() => void poll(), 2000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [buildingAssetKey, enabled, hasBuildingAsset, kind, scopeKey]);

  const provision = async () => {
    if (!workspace) return;
    const operationScope = scopeKey;
    setLoading(true);
    setNotice(null);
    try {
      await tencentdbApi.provisionWorkspaceAssets(workspace);
      if (!isCurrentScope(operationScope)) return;
      setNotice({ type: 'info', text: '工作区资产已登记，构建状态会自动刷新。' });
      await reload(true);
    } catch (cause) {
      if (!isCurrentScope(operationScope)) return;
      setNotice({ type: 'error', text: errorMessage(cause) });
    } finally {
      if (isCurrentScope(operationScope)) setLoading(false);
    }
  };

  const sync = async (id: string) => {
    const operationScope = scopeKey;
    setLoading(true);
    setNotice(null);
    try {
      if (kind === 'wiki') await tencentdbApi.syncWiki(id);
      else await tencentdbApi.syncCodeGraph(id);
      if (!isCurrentScope(operationScope)) return;
      setNotice({ type: 'info', text: '已提交重新同步，状态会自动刷新。' });
      await reload(true);
    } catch (cause) {
      if (!isCurrentScope(operationScope)) return;
      setNotice({ type: 'error', text: errorMessage(cause) });
    } finally {
      if (isCurrentScope(operationScope)) setLoading(false);
    }
  };

  const importWiki = async (id: string) => {
    const operationScope = scopeKey;
    setLoading(true);
    setNotice(null);
    try {
      const result = await tencentdbApi.importWikiFiles(id);
      if (!result || !isCurrentScope(operationScope)) return;
      setNotice({ type: 'info', text: `已上传 ${result.uploaded} 个文档，Wiki 正在构建。` });
      await reload(true);
    } catch (cause) {
      if (!isCurrentScope(operationScope)) return;
      setNotice({ type: 'error', text: errorMessage(cause) });
    } finally {
      if (isCurrentScope(operationScope)) setLoading(false);
    }
  };

  const openAsset = async (id: string, label: string) => {
    setSelected({ id, label });
    setQuery('');
    setWikiPages([]);
    setWikiSearch(null);
    setPageContent(null);
    setCodeGraphResult(null);
    setCodeGraphAction('search');
    setQueryLimit(20);
    if (kind !== 'wiki') return;
    setDetailLoading(true);
    try {
      const result = await tencentdbApi.listWikiPages(id);
      setWikiPages(result.items ?? []);
    } catch (cause) {
      setNotice({ type: 'error', text: errorMessage(cause) });
    } finally {
      setDetailLoading(false);
    }
  };

  const executeQuery = async () => {
    if (!selected || (kind === 'wiki' && !query.trim())) return;
    if (kind === 'codegraph' && !['status', 'files'].includes(codeGraphAction) && !query.trim()) return;
    setDetailLoading(true);
    try {
      if (kind === 'wiki') {
        setWikiSearch(await tencentdbApi.searchWiki(selected.id, query.trim(), 20));
      } else {
        const value = query.trim();
        switch (codeGraphAction) {
          case 'search':
            setCodeGraphResult(await tencentdbApi.searchCodeGraph(selected.id, value, queryLimit));
            break;
          case 'explore':
            setCodeGraphResult(await tencentdbApi.exploreCodeGraph(selected.id, value, queryLimit));
            break;
          case 'callers':
            setCodeGraphResult(await tencentdbApi.getCodeGraphCallers(selected.id, value, queryLimit));
            break;
          case 'callees':
            setCodeGraphResult(await tencentdbApi.getCodeGraphCallees(selected.id, value, queryLimit));
            break;
          case 'impact':
            setCodeGraphResult(await tencentdbApi.analyzeCodeGraphImpact(selected.id, value, queryLimit));
            break;
          case 'node':
            setCodeGraphResult(await tencentdbApi.getCodeGraphNode(selected.id, value, {
              includeCode,
              ...(nodeFile.trim() ? { file: nodeFile.trim() } : {}),
              ...(nodeLine ? { line: nodeLine } : {}),
            }));
            break;
          case 'status':
            setCodeGraphResult(await tencentdbApi.getCodeGraphStatus(selected.id));
            break;
          case 'files':
            setCodeGraphResult(await tencentdbApi.listCodeGraphFiles(selected.id, {
              ...(filesPath.trim() ? { path: filesPath.trim() } : {}),
              ...(filesPattern.trim() ? { pattern: filesPattern.trim() } : {}),
              format: filesFormat,
              includeMetadata,
              ...(maxDepth ? { maxDepth } : {}),
            }));
            break;
        }
      }
    } catch (cause) {
      setNotice({ type: 'error', text: errorMessage(cause) });
    } finally {
      setDetailLoading(false);
    }
  };

  const readPage = async (ref: string) => {
    if (!selected) return;
    setDetailLoading(true);
    try {
      const result = await tencentdbApi.readWikiPages(selected.id, [ref]);
      setPageContent(result.items?.[0] ?? { ref, not_found: true });
    } catch (cause) {
      setNotice({ type: 'error', text: errorMessage(cause) });
    } finally {
      setDetailLoading(false);
    }
  };

  const remove = async (id: string) => {
    const operationScope = scopeKey;
    setLoading(true);
    setNotice(null);
    try {
      if (kind === 'wiki') await tencentdbApi.deleteWiki(id, workspace);
      else await tencentdbApi.deleteCodeGraph(id, workspace);
      if (!isCurrentScope(operationScope)) return;
      if (selected?.id === id) setSelected(null);
      setNotice({ type: 'success', text: '资产已删除。' });
      await reload(true);
    } catch (cause) {
      if (!isCurrentScope(operationScope)) return;
      setNotice({ type: 'error', text: errorMessage(cause) });
    } finally {
      if (isCurrentScope(operationScope)) setLoading(false);
    }
  };

  const changeCodeGraphAction = (action: CodeGraphAction) => {
    setCodeGraphAction(action);
    setCodeGraphResult(null);
    setQuery('');
    setQueryLimit(action === 'explore' ? 12 : action === 'impact' ? 2 : 20);
  };

  const codeGraphNeedsQuery = !['status', 'files'].includes(codeGraphAction);

  if (!enabled) {
    return <Alert type="info" title="MemoryKnowledge 尚未连接" />;
  }

  return (
    <Flexbox gap={10} data-testid={`${kind}-assets`}>
      <Flexbox horizontal gap={8} align="center">
        <Button size="small" aria-label="刷新资产" icon={<RefreshCw size={14} />} onClick={() => void reload()} loading={loading} />
        {workspace ? (
          <Button size="small" type="primary" onClick={() => void provision()} loading={loading}>
            初始化当前工作区
          </Button>
        ) : <Tag>请先打开项目工作区</Tag>}
        {hasBuildingAsset ? <Tag color="processing">构建中，自动刷新</Tag> : null}
      </Flexbox>
      {notice ? <Alert role="alert" type={notice.type} title={notice.text} closable onClose={() => setNotice(null)} /> : null}
      {scopedKnowledge?.workspace?.error ? <Alert role="alert" type="warning" title={scopedKnowledge.workspace.error} /> : null}
      {loading && !scopedKnowledge ? <Spin size="small" /> : null}
      {!loading && rows.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无 TencentDB 资产" /> : null}
      {rows.map((row) => {
        const wiki = kind === 'wiki' ? row as TencentdbWiki : null;
        const codeGraph = kind === 'codegraph' ? row as TencentdbCodeGraph : null;
        const id = wiki?.wiki_id ?? codeGraph?.code_graph_id ?? '';
        const label = wiki?.name ?? codeGraph?.repo_name ?? id;
        const status = row.status;
        const building = isBuilding(status);
        const detail = wiki
          ? `${wiki.page_count ?? 0} 页`
          : `${codeGraph?.stats?.files ?? 0} 文件 · ${codeGraph?.branch ?? '默认分支'}`;
        return (
          <Flexbox key={id} horizontal justify="space-between" align="center" gap={12} style={{ borderBottom: '1px solid var(--ant-color-border)', padding: '8px 0' }}>
            <div style={{ minWidth: 0 }}>
              <div><strong>{label}</strong> <Tag color={status === 'failed' ? 'error' : building ? 'processing' : 'success'}>{status}</Tag></div>
              <small>{detail}</small>
              {row.sync_error ? <div role="alert">{row.sync_error}</div> : null}
            </div>
            <Flexbox horizontal gap={6}>
              {wiki ? <Button size="small" onClick={() => void importWiki(id)} disabled={building} loading={loading}>导入文档</Button> : null}
              <Button
                size="small"
                aria-label={`${wiki ? '浏览' : '查询'} ${label}`}
                icon={wiki ? <BookOpen size={14} /> : <Search size={14} />}
                onClick={() => void openAsset(id, label)}
                disabled={status !== 'ready'}
              />
              <Button size="small" onClick={() => void sync(id)} disabled={building} loading={loading}>重新同步</Button>
              <Popconfirm title={`永久删除 ${label}？`} okText="确定" cancelText="取消" onConfirm={() => remove(id)}>
                <Button danger size="small" aria-label={`删除 ${label}`} icon={<Trash2 size={14} />} />
              </Popconfirm>
            </Flexbox>
          </Flexbox>
        );
      })}

      <Modal
        title={selected ? `${kind === 'wiki' ? 'Wiki' : 'CodeGraph'} · ${selected.label}` : ''}
        open={Boolean(selected)}
        onCancel={() => setSelected(null)}
        footer={<Button onClick={() => setSelected(null)}>关闭</Button>}
        width={820}
      >
        {selected ? (
          <Flexbox gap={12}>
            {kind === 'wiki' ? (
              <Flexbox horizontal gap={8}>
                <Input
                  value={query}
                  placeholder="搜索 Wiki 内容"
                  onChange={(event) => setQuery(event.target.value)}
                  onPressEnter={() => void executeQuery()}
                />
                <Button
                  type="primary"
                  icon={<Search size={14} />}
                  onClick={() => void executeQuery()}
                  loading={detailLoading}
                  disabled={!query.trim()}
                >
                  搜索 Wiki
                </Button>
              </Flexbox>
            ) : (
              <Flexbox gap={8}>
                <Select<CodeGraphAction>
                  aria-label="CodeGraph 操作"
                  value={codeGraphAction}
                  options={codeGraphActions}
                  onChange={changeCodeGraphAction}
                  style={{ width: 180 }}
                />
                {codeGraphNeedsQuery ? (
                  <Flexbox horizontal gap={8}>
                    <Input
                      value={query}
                      placeholder={codeGraphAction === 'explore' ? '输入查询' : '输入符号'}
                      onChange={(event) => setQuery(event.target.value)}
                      onPressEnter={() => void executeQuery()}
                    />
                    {['search', 'explore', 'callers', 'callees', 'impact'].includes(codeGraphAction) ? (
                      <InputNumber
                        aria-label={codeGraphAction === 'impact' ? '分析深度' : codeGraphAction === 'explore' ? '最大文件数' : '结果数量'}
                        min={1}
                        max={codeGraphAction === 'impact' ? 10 : codeGraphAction === 'search' ? 100 : 200}
                        value={queryLimit}
                        onChange={(value) => setQueryLimit(value ?? 1)}
                        style={{ width: 120 }}
                      />
                    ) : null}
                  </Flexbox>
                ) : null}
                {codeGraphAction === 'node' ? (
                  <Flexbox horizontal gap={8}>
                    <Input value={nodeFile} placeholder="限定文件路径" onChange={(event) => setNodeFile(event.target.value)} />
                    <InputNumber aria-label="代码行号" min={1} value={nodeLine} onChange={setNodeLine} placeholder="行号" />
                    <Checkbox checked={includeCode} onChange={(event) => setIncludeCode(event.target.checked)}>包含源码</Checkbox>
                  </Flexbox>
                ) : null}
                {codeGraphAction === 'files' ? (
                  <>
                    <Flexbox horizontal gap={8}>
                      <Input value={filesPath} placeholder="路径前缀" onChange={(event) => setFilesPath(event.target.value)} />
                      <Input value={filesPattern} placeholder="Glob 模式" onChange={(event) => setFilesPattern(event.target.value)} />
                    </Flexbox>
                    <Flexbox horizontal gap={8} align="center">
                      <Select<TencentdbCodeGraphFilesFormat>
                        aria-label="文件展示格式"
                        value={filesFormat}
                        onChange={setFilesFormat}
                        options={[
                          { value: 'tree', label: '目录树' },
                          { value: 'flat', label: '平铺' },
                          { value: 'grouped', label: '分组' },
                        ]}
                        style={{ width: 120 }}
                      />
                      <InputNumber aria-label="最大目录深度" min={1} value={maxDepth} onChange={setMaxDepth} placeholder="最大深度" />
                      <Checkbox checked={includeMetadata} onChange={(event) => setIncludeMetadata(event.target.checked)}>包含元数据</Checkbox>
                    </Flexbox>
                  </>
                ) : null}
                <Button
                  type="primary"
                  icon={<Search size={14} />}
                  onClick={() => void executeQuery()}
                  loading={detailLoading}
                  disabled={codeGraphNeedsQuery && !query.trim()}
                  style={{ alignSelf: 'flex-start' }}
                >
                  执行查询
                </Button>
              </Flexbox>
            )}
            {detailLoading ? <Spin size="small" /> : null}
            {kind === 'wiki' ? (
              <>
                {wikiSearch?.results.map((result) => (
                  <Flexbox key={result.path} horizontal justify="space-between" align="center" gap={10}>
                    <div><strong>{result.title}</strong><div>{result.snippet}</div></div>
                    <Button size="small" aria-label={`读取 ${result.title}`} onClick={() => void readPage(result.path)}>读取</Button>
                  </Flexbox>
                ))}
                <strong>已生成页面</strong>
                {wikiPages.length === 0 && !detailLoading ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无已生成页面" /> : null}
                {wikiPages.map((page) => (
                  <Flexbox key={page.id} horizontal justify="space-between" align="center">
                    <span>{page.title} <Tag>{page.type}</Tag></span>
                    <Button size="small" aria-label={`读取 ${page.title}`} onClick={() => void readPage(page.id)}>读取</Button>
                  </Flexbox>
                ))}
                {pageContent ? (
                  pageContent.not_found
                    ? <Alert type="warning" title="页面不存在" />
                    : <pre style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 320, overflow: 'auto' }}>{pageContent.content}</pre>
                ) : null}
              </>
            ) : codeGraphResult !== null ? (
              codeGraphResult.isError
                ? <Alert type="error" title={codeGraphResult.text} />
                : <pre style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 420, overflow: 'auto' }}>{codeGraphResult.text}</pre>
            ) : null}
          </Flexbox>
        ) : null}
      </Modal>
    </Flexbox>
  );
}
