import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Segmented, Tag, Typography, message, type InputRef } from 'antd';
import { ArrowLeft, Database, FolderTree, LayoutList, ListFilter, Search } from 'lucide-react';
import { agentDataApi, type CodeRetrievalRequest, type ResourceNavigation } from '../../lib/agentData';
import { isUnder, pathKey, pathsEquivalent } from '../../lib/pathUtils';
import { CodeProjectList } from './CodeProjectList';
import { CodeRelations, CodeResultContent, codeRequestError } from './CodeRelations';
import { CodeSourceDetail } from './CodeSourceDetail';
import {
  appendCodeResultPage,
  CODE_PAGE_SIZE,
  decodeCodeResult,
  retainedCodeResult,
  type CodeResultRow,
  type CodeResultView,
} from './codeResult';
import { codeStyles as styles } from './codeStyles';
import { rememberIndexProject, useIndexProjectCatalog } from './useIndexProjectCatalog';
import { codeIndexPresentation } from './codeIndexPresentation';
import { formatRelative } from '../../lib/relativeTime';
import { openPath } from '../../platform/runtime';
import { CodeProjectHome } from './CodeProjectHome';
import { useIndexDirectory, directoryView, isIndexBusy, indexProgress, lastSync } from './useIndexDirectory';
import { IndexOverview, IndexFileRelations } from './IndexOverview';
import { IndexDirectoryRow } from './IndexDirectoryRow';
import { IndexFileActions, type IndexNotice } from './IndexFileActions';
import { pickDirectory } from '../../lib/dialog';
import { useSessionStore } from '../../store';
import { useSidebarPrefsStore } from '../../stores/sidebarPrefsStore';
import { browseStyles as b } from './codeBrowseStyles';
import { sourcePath } from './codeSourcePath';
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
/** loadingMore：文件列表正在取下一页；整个 QueryState 被新查询替换时它自然归零。 */
interface QueryState {
  workspace: string;
  result?: CodeResultView;
  retained?: CodeResultView;
  error?: string;
  loading: boolean;
  loadingMore?: boolean;
}
export function CodeRetrievalPanel({
  initialProject,
  visible = true,
  refreshToken = 0,
  navigation,
  navigationRequest = 0,
}: CodeRetrievalPanelProps) {
  const { projects, options, setListed } = useIndexProjectCatalog();
  const initial = useRef(initialProject);
  const initialMatch = options.find((option) => initial.current && pathsEquivalent(option.cwd, initial.current))?.cwd;
  const initialized = useRef(Boolean(initialMatch));
  const [selectedProject, setProject] = useState(initialMatch ?? '');
  const project = options.find((option) => pathsEquivalent(option.cwd, selectedProject))?.cwd ?? '';
  const [toast, holder] = message.useMessage();
  const notice = useCallback<IndexNotice>((kind, text) => {
    void toast.open({ type: kind, content: text });
  }, [toast]);
  const [query, setQuery] = useState('');
  const queries = useRef(new Map<string, string>());
  const [mode, setMode] = useState<'search' | 'explore'>('search');
  const [queryState, setQueryState] = useState<QueryState>();
  const [selected, setSelected] = useState<CodeResultRow>();
  const [selectionVersion, setSelectionVersion] = useState(0);
  const [nodeState, setNodeState] = useState<QueryState>();
  const [statusVersion, setStatusVersion] = useState(0);
  const directory = useIndexDirectory(options, project, visible, refreshToken + statusVersion, notice);
  const reload = refreshToken + statusVersion + directory.revision;
  const [showHidden, setShowHidden] = useState(false);
  const [layout, setLayout] = useState<'children' | 'flat'>('children');
  const [sort, setSort] = useState<'name' | 'references'>('name');
  const [mobileOverview, setMobileOverview] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const keyboardRow = useRef<HTMLElement | null>(null);
  const [pendingNavigation, setPendingNavigation] = useState<{
    key: string;
    workspace: string;
    file: string;
    line?: number;
  }>();
  const handledNavigation = useRef<string | undefined>(undefined);
  const navigationKey = navigation
    ? JSON.stringify([navigation.workspace, navigation.file, navigation.line, navigationRequest])
    : '';
  const navigationProject = navigation?.workspace
    ? projects.find((option) => pathsEquivalent(option.cwd, navigation.workspace!))?.cwd
    : undefined;
  const queryEpoch = useRef(0);
  const nodeEpoch = useRef(0);
  const resultTrigger = useRef<HTMLElement | null>(null);
  const queryInput = useRef<InputRef>(null);
  const restoreFocus = useRef(false);
  const entry = directory.entries[pathKey(project)];
  const currentStatus = entry?.status;
  const view = directoryView(entry);
  const syncing = isIndexBusy(entry);
  const date = lastSync(currentStatus);
  // 页头/标签用 view（受 checking 与刷新错误影响）；查询能力只看最近一次成功读到的状态，
  // 这样一次失败的状态刷新不会抹掉仍可读的旧结果，也不会让查询 effect 因 canQuery 抖动而多发一次请求。
  const canQuery =
    Boolean(project) &&
    Boolean(currentStatus) &&
    codeIndexPresentation({ status: currentStatus, checking: false }).canQuery;
  const currentResult = queryState?.workspace === project ? queryState : undefined;
  const currentNode = nodeState?.workspace === project ? nodeState : undefined;
  let queryTool: 'codegraph_search' | 'codegraph_explore' | 'codegraph_files' = 'codegraph_files';
  // 查询只认去掉首尾空白后的文本：只敲空格不该重取第一页，把已加载的页覆盖掉。
  const queryText = query.trim();
  if (queryText) queryTool = mode === 'search' ? 'codegraph_search' : 'codegraph_explore';
  // 文件列表由主进程分页返回（结果带 page）：只要是分页结果就一直走 more，最后一页到了 remaining 为 0，按钮消失但行不退回前端切页。
  const loadedResult = currentResult?.result;
  const moreFiles =
    queryTool === 'codegraph_files' && loadedResult?.page
      ? {
          remaining: Math.max(0, loadedResult.page.total - loadedResult.rows.length),
          loading: Boolean(currentResult?.loadingMore),
          onLoad: () => void loadMoreFiles(),
        }
      : undefined;

  useEffect(() => {
    if (!initialized.current && initialMatch) {
      initialized.current = true;
      setProject(initialMatch);
    }
  }, [initialMatch]);

  useEffect(() => {
    if (!visible || !navigation || handledNavigation.current === navigationKey || !navigationProject) return;
    handledNavigation.current = navigationKey;
    try { setListed(navigationProject, true); } catch (e) { notice('error', errorText(e)); return; }
    selectProject(navigationProject);
    queryEpoch.current++;
    nodeEpoch.current++;
    setQueryState(undefined);
    setNodeState(undefined);
    setSelected(undefined);
    restoreFocus.current = false;
    resultTrigger.current = null;
    setPendingNavigation(
      navigation.file
        ? { key: navigationKey, workspace: navigationProject, file: navigation.file, line: navigation.line }
        : undefined,
    );
    setStatusVersion((value) => value + 1);
  }, [navigationKey, navigationProject, visible]);

  useEffect(() => {
    if (
      !visible ||
      !canQuery ||
      !pendingNavigation ||
      pendingNavigation.key !== navigationKey ||
      !pathsEquivalent(pendingNavigation.workspace, project)
    )
      return;
    setSelected({ file: pendingNavigation.file, line: pendingNavigation.line });
    setSelectionVersion((value) => value + 1);
    setPendingNavigation(undefined);
  }, [pendingNavigation, navigationKey, project, canQuery, visible]);

  useEffect(() => {
    if (!selectedProject || project) return;
    initialized.current = true;
    queryEpoch.current++;
    nodeEpoch.current++;
    queries.current.set(pathKey(selectedProject), query);
    setProject('');
    setQuery('');
    setQueryState(undefined);
    setNodeState(undefined);
    setSelected(undefined);
    restoreFocus.current = false;
    resultTrigger.current = null;
  }, [selectedProject, project, query]);

  useEffect(() => {
    if (!visible || !canQuery) return;
    function shortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.key !== '/' ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        target?.closest('input, textarea, select, [contenteditable=true], [role=dialog], .ant-select-dropdown')
      )
        return;
      event.preventDefault();
      queryInput.current?.focus();
    }
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  }, [visible, canQuery]);
  function arrow(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    const items = Array.from(list.current?.querySelectorAll<HTMLElement>('[data-code-entry]') ?? []);
    if (!items.length) return;
    const idx = items.indexOf(keyboardRow.current!);
    if (event.key === 'Enter' && idx >= 0) {
      event.preventDefault();
      items[idx].click();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const i =
      idx < 0
        ? event.key === 'ArrowDown'
          ? 0
          : items.length - 1
        : Math.min(items.length - 1, Math.max(0, idx + (event.key === 'ArrowDown' ? 1 : -1)));
    const el = items[i];
    keyboardRow.current?.removeAttribute('data-key-active');
    keyboardRow.current = el;
    el.setAttribute('data-key-active', 'true');
    if (!el.hasAttribute('data-directory')) el.click();
    el.scrollIntoView?.({ block: 'nearest' });
  }
  const browseFormat = queryText ? undefined : layout;
  const browseSort = browseFormat === 'flat' ? sort : undefined;
  const fileArgs = {
    format: layout,
    hideIgnored: !showHidden,
    ...(browseSort ? { sort: browseSort } : {}),
    limit: CODE_PAGE_SIZE,
  };
  useEffect(() => {
    const epoch = ++queryEpoch.current;
    if (!visible || !canQuery) return;
    setQueryState((old) => ({
      workspace: project,
      result: old?.workspace === project ? old.result : undefined,
      retained: old?.workspace === project ? old.retained : undefined,
      loading: true,
    }));
    const request: CodeRetrievalRequest =
      queryTool === 'codegraph_files'
        ? { workspace: project, tool: queryTool, args: fileArgs }
        : { workspace: project, tool: queryTool, args: { query: queryText, limit: 20, hideIgnored: !showHidden } };
    void agentDataApi.code
      .call(request)
      .then((raw) => {
        if (epoch !== queryEpoch.current) return;
        const result = decodeCodeResult(queryTool, raw);
        setQueryState((old) => ({
          workspace: project,
          result,
          retained: retainedCodeResult(result, old?.result, old?.retained),
          loading: false,
        }));
      })
      .catch((cause) => {
        if (epoch === queryEpoch.current)
          setQueryState((old) => ({ ...old, workspace: project, error: codeRequestError(cause), loading: false }));
      });
    return () => {
      queryEpoch.current++;
    };
  }, [project, canQuery, queryText, queryTool, visible, reload, showHidden, browseFormat, browseSort]);

  useEffect(() => {
    const epoch = ++nodeEpoch.current;
    if (!visible || !project || !selected?.symbol || !canQuery) return;
    setNodeState((old) => ({
      workspace: project,
      result: old?.workspace === project ? old.result : undefined,
      retained: old?.workspace === project ? old.retained : undefined,
      loading: true,
    }));
    void agentDataApi.code
      .call({
        workspace: project,
        tool: 'codegraph_node',
        args: {
          symbol: selected.id ?? selected.symbol,
          ...(selected.file ? { file: selected.file } : {}),
          includeCode: true,
        },
      })
      .then((raw) => {
        if (epoch !== nodeEpoch.current) return;
        const result = decodeCodeResult('codegraph_node', raw);
        setNodeState((old) => ({
          workspace: project,
          result,
          retained: retainedCodeResult(result, old?.result, old?.retained),
          loading: false,
        }));
      })
      .catch((cause) => {
        if (epoch === nodeEpoch.current)
          setNodeState((old) => ({ ...old, workspace: project, error: codeRequestError(cause), loading: false }));
      });
    return () => {
      nodeEpoch.current++;
    };
  }, [project, selected?.id, selected?.symbol, selected?.file, selectionVersion, canQuery, visible, reload]);

  useEffect(() => {
    if (selected || !restoreFocus.current || !visible) return;
    restoreFocus.current = false;
    if (resultTrigger.current?.isConnected) resultTrigger.current.focus();
    else queryInput.current?.focus();
  }, [selected, visible]);

  const selectProject = useCallback((target: string) => {
    initialized.current = true;
    if (target === project) return;
    setPendingNavigation(undefined);
    queryEpoch.current++;
    nodeEpoch.current++;
    queries.current.set(pathKey(project), query);
    if (target) rememberIndexProject(target);
    setMobileOverview(false);
    keyboardRow.current = null;
    setProject(target);
    setQuery(queries.current.get(pathKey(target)) ?? '');
    setQueryState(undefined);
    setNodeState(undefined);
    setSelected(undefined);
    restoreFocus.current = false;
    resultTrigger.current = null;
  }, [project, query]);

  // changeQuery / changeMode 不手动递增 queryEpoch：查询真的变了，查询 effect 的清理会递增；
  // 没变（只敲了空格、空查询下切模式）时 effect 不重跑，手动递增只会让在途的响应被丢掉而没有新请求顶上，列表卡在「正在查询」。
  function changeQuery(next: string) {
    if (query.trim() !== next.trim()) {
      keyboardRow.current = null;
      setMobileOverview(false);
    }
    setQuery(next);
    queries.current.set(pathKey(project), next);
  }

  function selectResult(row: CodeResultRow, trigger: HTMLElement) {
    nodeEpoch.current++;
    resultTrigger.current = trigger;
    keyboardRow.current = trigger;
    setNodeState(undefined);
    setSelected(row);
    setSelectionVersion((value) => value + 1);
  }

  function clearBrowseResults() {
    queryEpoch.current++;
    setQueryState(undefined);
    keyboardRow.current = null;
  }

  function changeLayout(next: typeof layout) {
    if (next === layout) return;
    clearBrowseResults();
    setLayout(next);
  }

  function changeVisibility() {
    clearBrowseResults();
    nodeEpoch.current++;
    setNodeState(undefined);
    setSelected(undefined);
    setShowHidden(!showHidden);
  }

  function changeMode(next: 'search' | 'explore') {
    if (next === mode) return;
    setMode(next);
  }

  function closeDetail() {
    nodeEpoch.current++;
    restoreFocus.current = true;
    setMobileOverview(false);
    setSelected(undefined);
    setNodeState(undefined);
  }

  /** 不递增 queryEpoch：新查询、换项目、刷新都会递增它，到达时已过期的下一页就此丢弃。 */
  async function loadMoreFiles() {
    const loaded = currentResult?.result;
    if (
      !loaded?.page ||
      currentResult?.loading ||
      currentResult?.loadingMore ||
      !visible ||
      !canQuery ||
      queryTool !== 'codegraph_files'
    )
      return;
    const epoch = queryEpoch.current;
    const workspace = project;
    const patch = (change: Partial<QueryState>) =>
      setQueryState((old) =>
        old?.workspace === workspace && epoch === queryEpoch.current ? { ...old, ...change } : old,
      );
    patch({ loadingMore: true });
    try {
      const raw = await agentDataApi.code.call({
        workspace,
        tool: 'codegraph_files',
        args: { ...fileArgs, offset: loaded.rows.length },
      });
      if (epoch !== queryEpoch.current) return;
      const next = decodeCodeResult('codegraph_files', raw);
      if (next.isError || next.recognition !== 'rows') {
        patch({
          loadingMore: false,
          error: codeRequestError(next.text ?? next.message ?? 'CodeGraph 返回错误，详情见原始结果。'),
        });
        return;
      }
      // 总数变了说明两次取页之间索引被改过，按 offset 接上去会跳行或重复：整个重读，回到第一页。
      if (next.page?.total !== loaded.page.total) {
        setStatusVersion((value) => value + 1);
        return;
      }
      setQueryState((old) =>
        old?.workspace === workspace && old.result
          ? { ...old, result: appendCodeResultPage(old.result, next), loadingMore: false, error: undefined }
          : old,
      );
    } catch (cause) {
      patch({ loadingMore: false, error: codeRequestError(cause) });
    }
  }

  async function addProject() {
    try {
      const path = await pickDirectory();
      if (!path) return;
      const session = useSessionStore.getState();
      if (session.worksDir && isUnder(path, session.worksDir)) {
        notice('info', '临时对话目录不能作为本地项目。');
        return;
      }
      setListed(path, true);
      session.registerProject(path);
      useSidebarPrefsStore.getState().keepProject(path);
      selectProject(options.find((o) => pathsEquivalent(o.cwd, path))?.cwd ?? path);
    } catch (e) {
      notice('error', '无法添加本地项目：' + errorText(e));
    }
  }
  const staleProjects = options.filter((p) => directoryView(directory.entries[pathKey(p.cwd)]).label === '需更新');
  const syncingCount = options.filter((p) => isIndexBusy(directory.entries[pathKey(p.cwd)])).length;
  async function syncStaleProjects() {
    // Submit only the currently stale set. The existing scheduler owns write concurrency.
    for (const p of staleProjects) await directory.sync(p.cwd);
  }
  const showDirectory = useCallback(
    (path: string) => {
      void openPath(path).catch((e) => notice('error', errorText(e)));
    },
    [notice],
  );
  const removeProject = useCallback(
    (path: string) => {
      try {
        setListed(path, false);
        notice('success', '已从代码索引列表移除，可重新添加。');
      } catch (e) {
        notice('error', '无法保存项目列表：' + errorText(e));
      }
    },
    [notice, setListed],
  );
  const sync = () => directory.sync(project);
  const actions = (file: string) => <IndexFileActions workspace={project} file={file} notice={notice} />;
  const warnings = [
    view.banner?.type !== 'info' ? view.banner?.message : undefined,
    currentStatus?.message && !view.banner?.message.includes(currentStatus.message) ? currentStatus.message : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <section data-testid="code-retrieval-panel" className={styles.root}>
      {holder}
      {!project ? (
        <header className={b.lobbyBar}>
          <h2>代码索引</h2>
          <div className={b.lobbyStats} aria-label="项目概览">
            <span>共 {options.length} 个项目</span>
            {staleProjects.length > 0 && (
              <>
                <span aria-hidden>·</span>
                <span data-stale>{staleProjects.length} 个待更新</span>
              </>
            )}
            {syncingCount > 0 && (
              <>
                <span aria-hidden>·</span>
                <span>{syncingCount} 个同步中</span>
              </>
            )}
          </div>
        </header>
      ) : (
        <header className={b.toolbar}>
          <div className={b.projectHeading}>
            <Button
              aria-label="返回项目列表"
              title="返回项目列表"
              type="text"
              icon={<ArrowLeft size={17} />}
              onClick={() => selectProject('')}
            />
            <h2>代码索引</h2>
          </div>
          <CodeProjectList
            options={options}
            project={project}
            entries={directory.entries}
            onSelect={selectProject}
            onAdd={() => void addProject()}
          />
          <div className={b.statsSlot} data-index-stats>
            <span
              className={b.badge}
              data-tone={view.color}
              data-testid="code-index-state"
              title={view.banner?.message}
            >
              {view.label}
            </span>
            <span data-stat-strip role="status">
              {syncing ? (
                <span data-index-progress>{indexProgress(entry)}</span>
              ) : (
                <>
                  {warnings && (
                    <span title={warnings} role={view.banner?.type === 'error' ? 'alert' : undefined}>
                      {warnings}
                    </span>
                  )}
                  {currentStatus?.indexed && (
                    <>
                      <span>{currentStatus.files?.toLocaleString() ?? '未提供'} 文件</span>
                      <span>{currentStatus.nodes?.toLocaleString() ?? '未提供'} 节点</span>
                      <span>{currentStatus.edges?.toLocaleString() ?? '未提供'} 边</span>
                    </>
                  )}
                  {date && <span title={new Date(date).toLocaleString()}>同步于 {formatRelative(date)}</span>}
                  {currentStatus?.indexed && view.freshness === 'unknown' && (
                    <span data-testid="code-index-freshness">新鲜度未知</span>
                  )}
                </>
              )}
            </span>
          </div>
          <div className={b.controls} data-index-controls>
            {(view.primary !== 'none' || syncing) && (
              <Button
                type={view.primary === 'build' ? 'primary' : 'default'}
                loading={syncing}
                disabled={!visible || syncing}
                onClick={() => void sync()}
              >
                {syncing ? '同步中' : view.primary === 'build' ? '建立索引' : '同步索引'}
              </Button>
            )}
            <MoreMenu
              label="代码索引更多操作"
              items={[
                { key: 'hidden', label: showHidden ? '隐藏非核心文件' : '显示隐藏文件与生成产物' },
                { key: 'status', label: '刷新状态' },
                { key: 'open', label: '打开项目目录' },
              ]}
              onSelect={(key) => {
                if (key === 'hidden') changeVisibility();
                if (key === 'status') setStatusVersion((v) => v + 1);
                if (key === 'open') showDirectory(project);
              }}
            />
          </div>
        </header>
      )}
      {!project ? (
        <CodeProjectHome
          options={options}
          entries={directory.entries}
          onSelect={selectProject}
          onAdd={() => void addProject()}
          staleCount={staleProjects.length}
          onSync={directory.sync}
          onSyncAll={() => void syncStaleProjects()}
          onOpen={showDirectory}
          onRemove={removeProject}
        />
      ) : view.primary === 'build' && !syncing ? (
        <div className={w.empty}>
          <span className={w.emptyIcon}>
            <Database size={20} />
          </span>
          <span className={w.emptyTitle}>这个项目还没有索引</span>
          <span className={w.emptyText}>{project}</span>
          <Button type="primary" disabled={!visible || syncing} onClick={() => void sync()}>
            建立索引
          </Button>
        </div>
      ) : (
        <div className={`${w.panel} ${styles.fill}`} data-testid="code-index-workbench">
          <div className={w.panelToolbar}>
            <Input
              ref={queryInput}
              aria-label="搜索代码"
              prefix={
                <span className={styles.searchIcon}>
                  <Search size={14} />
                </span>
              }
              allowClear
              placeholder={mode === 'search' ? '搜索符号或文件名；留空浏览文件' : '描述要找的功能'}
              value={query}
              onKeyDown={arrow}
              suffix={<kbd>/</kbd>}
              onChange={(event) => changeQuery(event.target.value)}
              disabled={!canQuery}
              style={{ flex: 1 }}
            />
            <Segmented
              value={mode}
              disabled={!canQuery}
              onChange={(value) => changeMode(value as 'search' | 'explore')}
              options={[
                { value: 'search', label: '符号' },
                { value: 'explore', label: '相关上下文', disabled: !query.trim() },
              ]}
            />
            <Button
              className={b.mobileOverview}
              size="small"
              onClick={() => {
                setSelected(undefined);
                setMobileOverview(!mobileOverview);
              }}
            >
              {mobileOverview ? '浏览文件' : '项目概览'}
            </Button>
          </div>
          <SplitPane
            className={styles.split}
            detailOpen={Boolean(selected) || mobileOverview}
            side={
              <div ref={list} className={styles.column} data-code-list>
                <div className={b.browseHead}>
                  <span data-count>
                    {currentResult?.result
                      ? (currentResult.result.page?.total ?? currentResult.result.rows.length) + ' 个结果'
                      : '浏览文件'}
                  </span>
                  {!queryText && (
                    <div className={b.viewButtons} role="radiogroup" aria-label="文件视图">
                      <button
                        title="目录树视图"
                        aria-label="目录树视图"
                        role="radio"
                        aria-checked={layout === 'children'}
                        onClick={() => changeLayout('children')}
                      >
                        <FolderTree size={15} />
                      </button>
                      <button
                        title="平铺列表"
                        aria-label="平铺列表"
                        role="radio"
                        aria-checked={layout === 'flat'}
                        onClick={() => changeLayout('flat')}
                      >
                        <LayoutList size={15} />
                      </button>
                      {layout === 'flat' && (
                        <button
                          aria-label={'排序：' + (sort === 'name' ? '文件名' : '核心引用度')}
                          title="切换文件名 / 核心引用度排序"
                          onClick={() => {
                            clearBrowseResults();
                            setSort(sort === 'name' ? 'references' : 'name');
                          }}
                          style={{ display: 'flex', gap: 4 }}
                        >
                          <ListFilter size={13} />
                          {sort === 'name' ? '文件名' : '引用度'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {currentResult?.loading ? (
                  <Typography.Text type="secondary" role="status">
                    正在查询代码…
                  </Typography.Text>
                ) : null}
                {currentResult?.error ? (
                  <Alert
                    type="error"
                    showIcon
                    title={`${currentResult.error}${currentResult.result ? ' 当前显示上次成功读取的结果。' : ''}`}
                  />
                ) : null}
                {currentResult?.result ? (
                  <CodeResultContent
                    key={`${project}\0${queryTool}\0${queryText}`}
                    result={currentResult.result}
                    retained={currentResult.retained}
                    onSelect={selectResult}
                    selected={selected}
                    tool={queryTool}
                    more={moreFiles}
                    browser={{
                      actions,
                      directory: (row) => (
                        <IndexDirectoryRow
                          workspace={project}
                          path={row.file!}
                          fileCount={row.fileCount}
                          hideIgnored={!showHidden}
                          revision={reload}
                          enabled={visible && canQuery}
                          onSelect={selectResult}
                          selected={selected}
                          actions={actions}
                        />
                      ),
                    }}
                  />
                ) : null}
              </div>
            }
            main={
              <>
                {selected && (
                  <div className={styles.detailColumn} aria-label="代码详情">
                    <div className={styles.detailHeader}>
                      <Button
                        type="text"
                        size="small"
                        aria-label="返回结果列表"
                        title="返回结果列表"
                        icon={<ArrowLeft size={16} />}
                        onClick={closeDetail}
                      />
                      <span className={styles.detailTitle}>
                        <Typography.Title level={5}>
                          {selected.symbol ?? baseName(selected.file) ?? '代码详情'}
                        </Typography.Title>
                        {selected.file ? (
                          <span className={styles.detailPath} title={selected.file}>
                            {selected.file}
                          </span>
                        ) : null}
                      </span>
                      {selected.file && actions(selected.file)}
                      {selected.kind ? <Tag>{selected.kind}</Tag> : null}
                    </div>
                    {selected.file ? (
                      <CodeSourceDetail
                        headerActions
                        workspace={project}
                        file={selected.file}
                        line={selected.line}
                        visible={visible && canQuery}
                        reloadVersion={reload}
                      />
                    ) : (
                      <Typography.Text type="secondary">未提供文件位置，无法打开源码。</Typography.Text>
                    )}
                    {!selected.symbol && selected.file && sourcePath(project, selected.file) && (
                      <div className={styles.contextSection}>
                        <IndexFileRelations
                          key={project + '|' + selected.file}
                          workspace={project}
                          file={selected.file}
                          enabled={visible && canQuery}
                          revision={reload}
                          onSelect={selectResult}
                        />
                      </div>
                    )}
                    {selected.symbol ? (
                      <div className={styles.contextSection}>
                        {currentNode?.loading ? (
                          <Typography.Text type="secondary" role="status">
                            正在读取符号上下文…
                          </Typography.Text>
                        ) : null}
                        {currentNode?.error ? <Alert type="error" showIcon title={currentNode.error} /> : null}
                        {currentNode?.result ? (
                          <details className={styles.raw} open={currentNode.result.isError || undefined}>
                            <summary>符号上下文</summary>
                            <CodeResultContent result={currentNode.result} retained={currentNode.retained} />
                          </details>
                        ) : null}
                        <CodeRelations
                          workspace={project}
                          symbol={selected.symbol}
                          nodeId={selected.id}
                          file={selected.file}
                          visible={visible && canQuery}
                          reloadVersion={reload}
                        />
                      </div>
                    ) : null}
                  </div>
                )}
                <div hidden={Boolean(selected)}>
                  <IndexOverview
                    key={project + '|' + showHidden}
                    workspace={project}
                    enabled={visible && canQuery}
                    hideIgnored={!showHidden}
                    revision={reload}
                    onSelect={selectResult}
                  />
                </div>
              </>
            }
          />
        </div>
      )}
    </section>
  );
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
function baseName(file?: string): string | undefined {
  return file ? file.replace(/\\/g, '/').split('/').pop() || file : undefined;
}
