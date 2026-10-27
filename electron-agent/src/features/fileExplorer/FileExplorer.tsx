import { App } from 'antd';
import { useThemeMode } from 'antd-style';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { useElementMeasure } from '../../hooks/useElementMeasure';
import { files } from '../../lib/files';
import { openUrl } from '../../platform/runtime';
import { useFileOpenRequests } from '../../stores/fileOpenRequests';
import { setDockCloseGuard } from '../dock/dockCloseGuards';
import { openInAppBrowser } from '../dock/browser/openInAppBrowser';
import { FilePathBar } from './FilePathBar';
import { fileExplorerStyles as styles } from './fileExplorerStyles';
import { parentDir } from './fileKinds';
import { FileTabBar } from './FileTabBar';
import { FileTabPane, type FileTabSummary } from './FileTabPane';
import {
  activateFileTab,
  closeFileTabs,
  EMPTY_FILE_TABS,
  openFileTab,
  tabsInScope,
  type CloseScope,
  type FileTabsState,
} from './fileTabsModel';
import { FileTree } from './FileTree';
import { FileViewer } from './FileViewer';
import { findProjectEntry } from './findProjectEntry';
import { resolveMarkdownLink } from './markdownLinks';
import { revealInTree } from './revealInTree';
import { toTreePath } from './treeModel';
import { askUnsaved, registerUnsaved } from './unsavedChanges';
import { registerFindScope } from '../find/findActions';
import { useFindStore } from '../find/findStore';
import { directionOfMouseButton, registerNavTarget, triggerNavigation, type NavTarget } from './fileNavBus';
import { useFileHistory } from './useFileHistory';
import { useFileTree } from './useFileTree';
import { useFileTreeMenu } from './useFileTreeMenu';
import type { OpenFileApi } from './useOpenFile';

const TREE_WIDTH_KEY = 'hermes-file-explorer-tree-width';
const TREE_COLLAPSED_KEY = 'hermes-file-explorer-tree-collapsed';
const DEFAULT_TREE_WIDTH = 240;
const MIN_TREE_WIDTH = 160;
const MIN_VIEWER_WIDTH = 240;
/** 比这还窄（右侧栏拖到最小 320px 时），文件树和内容区并排放不下，改成一次只显示一个。 */
const NARROW_WIDTH = MIN_TREE_WIDTH + MIN_VIEWER_WIDTH;
const isNarrowWidth = (width: number) => width > 0 && width < NARROW_WIDTH;

function readTreeWidth(): number {
  const stored = Number(localStorage.getItem(TREE_WIDTH_KEY));
  return Number.isFinite(stored) && stored >= MIN_TREE_WIDTH ? stored : DEFAULT_TREE_WIDTH;
}

function readTreeCollapsed(): boolean {
  return localStorage.getItem(TREE_COLLAPSED_KEY) === '1';
}

function clampTreeWidth(width: number, total: number): number {
  const max = Math.max(MIN_TREE_WIDTH, total - MIN_VIEWER_WIDTH);
  return Math.round(Math.min(max, Math.max(MIN_TREE_WIDTH, width)));
}

const noop = () => {};

/** 没有打开任何文件时给内容区的空 api：只显示导航工具栏和「从右边选一个文件查看」。 */
const IDLE_API: OpenFileApi = {
  file: { status: 'idle' },
  dirty: false,
  open: async () => false,
  setContent: noop,
  noteEdit: noop,
  bindEditorText: noop,
  setMode: noop,
  toggleMode: noop,
  save: async () => false,
  reloadFromDisk: async () => {},
  keepLocal: noop,
  onFilesChanged: noop,
  resolveUnsaved: async () => true,
  isDirty: () => false,
};

export interface FileExplorerProps {
  workspace: string;
  /** 标签 id：目录监听、关闭守卫、未保存登记都按它区分。 */
  watchId: string;
  /** 上次打开着的文件标签（dock 持久化里读回来的），只在挂载时用一次。 */
  initialTabs?: FileTabsState;
  /** 文件标签变了（开、关、切）。 */
  onTabsChange?: (tabs: FileTabsState) => void;
}

/**
 * 项目文件管理器：左边内容（顶上一排文件标签，每个标签 markdown 预览 / 代码只读，都可切到编辑），
 * 右边文件树，文件树可以收起。点文件树 / md 内链 / 外部请求打开文件：已经开着就切过去，否则新开一个标签。
 */
export function FileExplorer({ workspace, watchId, initialTabs, onTabsChange }: FileExplorerProps) {
  const { modal, message } = App.useApp();
  const { isDarkMode } = useThemeMode();
  const confirm = useCallback((fileName: string) => askUnsaved(modal, fileName), [modal]);

  // —— 文件标签 ——
  const [tabs, setTabsState] = useState<FileTabsState>(() => initialTabs ?? EMPTY_FILE_TABS);
  const tabsRef = useRef(tabs);
  const setTabs = useCallback((fn: (cur: FileTabsState) => FileTabsState) => {
    const next = fn(tabsRef.current);
    if (next === tabsRef.current) return;
    tabsRef.current = next;
    setTabsState(next);
  }, []);
  const openPath = tabs.active;
  // 激活过的标签才挂内容、读盘；重启后恢复出来但没点过的只占一个标签位。
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set(openPath ? [openPath] : []));
  useEffect(() => {
    if (openPath && !visited.has(openPath)) setVisited((prev) => new Set(prev).add(openPath));
  }, [openPath, visited]);
  const mountedPaths = useMemo(
    () => tabs.paths.filter((p) => p === openPath || visited.has(p)),
    [tabs.paths, openPath, visited],
  );

  const onTabsChangeRef = useRef(onTabsChange);
  onTabsChangeRef.current = onTabsChange;
  useEffect(() => {
    onTabsChangeRef.current?.(tabs);
  }, [tabs]);

  /** 各标签最新的 api（每次渲染登记）：快捷键、刷新、监听分发、未保存检查都从这里取。 */
  const apisRef = useRef(new Map<string, OpenFileApi>());
  const registerApi = useCallback((path: string, api: OpenFileApi | null) => {
    if (api) apisRef.current.set(path, api);
    else apisRef.current.delete(path);
  }, []);
  const [summaries, setSummaries] = useState<Readonly<Record<string, FileTabSummary>>>({});
  const onSummary = useCallback((path: string, summary: FileTabSummary | null) => {
    setSummaries((prev) => {
      const cur = prev[path];
      if (!summary) {
        if (!cur) return prev;
        const next = { ...prev };
        delete next[path];
        return next;
      }
      if (cur && cur.status === summary.status && cur.dirty === summary.dirty) return prev;
      return { ...prev, [path]: summary };
    });
  }, []);
  const dirtyPaths = useMemo(
    () => new Set(Object.entries(summaries).filter(([, s]) => s.dirty).map(([p]) => p)),
    [summaries],
  );
  const activeApi = (): OpenFileApi => (openPath ? apisRef.current.get(openPath) : undefined) ?? IDLE_API;

  /** 打开一个文件：已开着就切过去，否则新开标签。不再替换当前文件，所以也不用先问未保存修改。 */
  const openFile = useCallback(
    async (path: string): Promise<boolean> => {
      setTabs((s) => openFileTab(s, path));
      return true;
    },
    [setTabs],
  );

  /** 关标签：有未保存修改的先切过去问；取消就停在那里，已问过的照样关。 */
  const closeFiles = useCallback(
    async (targets: readonly string[]): Promise<boolean> => {
      const before = tabsRef.current.active;
      const done: string[] = [];
      let cancelled = false;
      for (const path of targets) {
        const api = apisRef.current.get(path);
        if (api?.isDirty()) {
          setTabs((s) => activateFileTab(s, path));
          if (!(await api.resolveUnsaved())) {
            cancelled = true;
            break;
          }
        }
        done.push(path);
      }
      setTabs((s) => closeFileTabs(s, done, cancelled ? s.active : before));
      return !cancelled;
    },
    [setTabs],
  );
  const onCloseTab = useCallback(
    (path: string, scope: CloseScope) => void closeFiles(tabsInScope(tabsRef.current, path, scope)),
    [closeFiles],
  );
  const onActivateTab = useCallback((path: string) => setTabs((s) => activateFileTab(s, path)), [setTabs]);

  // 关窗口 / 关这个 dock 标签前：所有有未保存修改的文件标签逐个问。
  const isDirty = useCallback(() => [...apisRef.current.values()].some((api) => api.isDirty()), []);
  const resolveUnsaved = useCallback(async (): Promise<boolean> => {
    for (const path of [...tabsRef.current.paths]) {
      const api = apisRef.current.get(path);
      if (!api?.isDirty()) continue;
      setTabs((s) => activateFileTab(s, path));
      if (!(await api.resolveUnsaved())) return false;
    }
    return true;
  }, [setTabs]);
  const onFilesChanged = useCallback((event: Parameters<OpenFileApi['onFilesChanged']>[0]) => {
    for (const api of apisRef.current.values()) api.onFilesChanged(event);
  }, []);

  const watchDirs = useMemo(() => [...new Set(mountedPaths.map(parentDir))], [mountedPaths]);
  const tree = useFileTree(workspace, watchId, watchDirs);
  const { refreshDirs } = tree;
  const history = useFileHistory(openPath, openFile);
  const treeMenu = useFileTreeMenu(tree.root, workspace);

  // 文件内查找：范围 id 就是 dock 标签 id，只有当前文件标签是文本（预览 / 代码）时能查，图片、二进制、空白不拦 Ctrl+F。
  const openPathRef = useRef(openPath);
  openPathRef.current = openPath;
  useEffect(
    () =>
      registerFindScope(watchId, () => {
        const path = openPathRef.current;
        return !!path && apisRef.current.get(path)?.file.status === 'text';
      }),
    [watchId],
  );
  useEffect(() => () => useFindStore.getState().forget(watchId), [watchId]);

  // 外部入口（交付卡、审查标签）发来的「打开这个文件」请求：等根目录列出来后接手，
  // 走和点文件树同一条 open（已开着就切过去、不重新读盘），再把祖先目录展开。
  const openRequest = useFileOpenRequests((state) => state.byTab[watchId]);
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const treeRoot = tree.root;
  useEffect(() => {
    if (!openRequest || !treeRoot) return;
    useFileOpenRequests.getState().consume(watchId, openRequest.nonce);
    const path = toTreePath(treeRoot, workspace, openRequest.path);
    void openFile(path);
    void revealInTree(() => treeRef.current, path);
  }, [openRequest, treeRoot, workspace, watchId, openFile]);

  // markdown 预览里的链接。网页 → 内置浏览器（Ctrl / ⌘ 点击用系统浏览器）；项目内文件 → 走和点文件树同一条 open；
  // 目录 → 在文件树里展开；找不到 / 不支持的 → 弹提示，不动当前文档。
  const openLink = useCallback(
    async (href: string, options: { system: boolean }) => {
      const root = treeRef.current.root;
      const filePath = openPathRef.current;
      if (!root || !filePath) return;
      const target = resolveMarkdownLink(href, { root, filePath });
      switch (target.kind) {
        case 'anchor':
          return;
        case 'unsupported':
          void message.warning(target.reason);
          return;
        case 'external':
          if (options.system) {
            await openUrl(target.url).catch((err: unknown) => {
              void message.error(`无法用系统浏览器打开：${err instanceof Error ? err.message : String(err)}`);
            });
          } else if (!openInAppBrowser(target.url)) {
            void message.warning('无法打开这个链接');
          }
          return;
        case 'file': {
          const entry = target.rel ? await findProjectEntry(workspace, target.path) : { status: 'dir' as const, path: target.path };
          if (entry.status === 'missing') {
            void message.warning(`找不到链接指向的文件：${target.rel}`);
            return;
          }
          if (entry.status === 'dir') {
            await revealInTree(() => treeRef.current, entry.path, { includeSelf: true });
            void message.info(`${target.rel || '项目根'} 是目录，已在文件树里展开`);
            return;
          }
          void openFile(entry.path);
          void revealInTree(() => treeRef.current, entry.path);
        }
      }
    },
    [message, workspace, openFile],
  );

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void files
      .onChanged((event) => {
        if (event.watchId !== watchId) return;
        refreshDirs(event.dirs);
        onFilesChanged(event);
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [watchId, refreshDirs, onFilesChanged]);

  useEffect(() => registerUnsaved(watchId, { isDirty, resolve: resolveUnsaved }), [watchId, isDirty, resolveUnsaved]);
  useEffect(() => setDockCloseGuard(watchId, resolveUnsaved), [watchId, resolveUnsaved]);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const [treeWidth, setTreeWidth] = useState(readTreeWidth);
  const [treeCollapsed, setTreeCollapsed] = useState(readTreeCollapsed);
  const [dragging, setDragging] = useState(false);
  const [hoverPath, setHoverPath] = useState<string | null>(null);

  // 刷新：把已列出的目录重新列一遍（根列不出来就重试根），打开着的文件标签都重新读盘。
  // 文件走和目录监听同一条 onFilesChanged：没改过就什么都不变，没有本地修改就静默换新，
  // 有本地修改就出「磁盘上被改过」的冲突提示（不会惄惄丢掉用户的编辑）；打开失败的文件也会重试。
  const [refreshing, setRefreshing] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (refreshTimer.current && clearTimeout(refreshTimer.current)), []);
  const refresh = useCallback(() => {
    const current = treeRef.current;
    if (current.error) current.reload();
    else current.refreshDirs([...current.dirs.keys()]);
    for (const [path, api] of apisRef.current) api.onFilesChanged({ dirs: [parentDir(path)], paths: [path] });
    setRefreshing(true);
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => setRefreshing(false), 600);
  }, []);

  // 鼠标侧键 / 键盘的浏览器前进后退键。侧键在面板上按下走 onMouseUp（button 3 / 4）；
  // Windows 上同一次按键还会以 app-command 经主进程送来，由总线在没有鼠标位置时按悬停 / 焦点认领。两条路同方向 250ms 内只认一次。
  const historyRef = useRef(history);
  historyRef.current = history;
  const navTarget = useRef<NavTarget>({
    element: () => rootRef.current,
    go: (direction) => (direction === 'back' ? historyRef.current.back() : historyRef.current.forward()),
  }).current;
  useEffect(() => registerNavTarget(navTarget), [navTarget]);
  const swallowSideButton = (event: MouseEvent<HTMLDivElement>) => {
    if (directionOfMouseButton(event.button) === null) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const onMouseUp = (event: MouseEvent<HTMLDivElement>) => {
    const direction = directionOfMouseButton(event.button);
    if (direction === null) return;
    swallowSideButton(event);
    triggerNavigation(navTarget, direction);
  };

  // 每个文件标签都拿它：稳住引用，打字、切未保存状态时不让所有标签跟着重渲。
  const nav = useMemo(
    () => ({
      canBack: history.canBack,
      canForward: history.canForward,
      refreshing,
      onBack: history.back,
      onForward: history.forward,
      onRefresh: refresh,
    }),
    [history.canBack, history.canForward, history.back, history.forward, refreshing, refresh],
  );

  // 窄面板：文件树和内容区一次只显示一个，打开文件就切到内容，点边上的按钮切回文件树。
  const narrow = useElementMeasure(rootRef, isNarrowWidth);
  const [narrowPane, setNarrowPane] = useState<'tree' | 'viewer'>('tree');
  useEffect(() => {
    if (openPath) setNarrowPane('viewer');
  }, [openPath]);
  const showTree = narrow ? narrowPane === 'tree' : !treeCollapsed;
  // 存下来的宽度是上次的；Dock 变窄时按当前宽度收一收，内容区至少留 MIN_VIEWER_WIDTH。
  const shownTreeWidth = useElementMeasure(
    rootRef,
    useCallback((rootWidth: number) => (rootWidth > 0 ? clampTreeWidth(treeWidth, rootWidth) : treeWidth), [treeWidth]),
  );

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (!root) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const right = root.getBoundingClientRect().right;
    const total = root.getBoundingClientRect().width;
    let latest = shownTreeWidth;
    setDragging(true);
    const move = (e: globalThis.PointerEvent) => {
      latest = clampTreeWidth(right - e.clientX, total);
      setTreeWidth(latest);
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      setDragging(false);
      localStorage.setItem(TREE_WIDTH_KEY, String(latest));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  // 快捷键只在这个标签里生效：Alt+← / Alt+→ 后退 / 前进，F5 刷新，Ctrl+S 保存，Ctrl+E 切换预览 / 编辑，Esc 退出编辑。
  // Alt+← / → 在编辑器里是「按语法节点移动光标」，CodeMirror 已处理（defaultPrevented）就不再当成导航。
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.defaultPrevented) {
      if (event.key === 'ArrowLeft' && history.canBack) {
        event.preventDefault();
        history.back();
        return;
      }
      if (event.key === 'ArrowRight' && history.canForward) {
        event.preventDefault();
        history.forward();
        return;
      }
    }
    if (event.key === 'F5' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      refresh();
      return;
    }
    const api = activeApi();
    const file = api.file;
    if (file.status !== 'text') return;
    const mod = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
    const key = event.key.toLowerCase();
    if (mod && key === 's') {
      event.preventDefault();
      if (api.dirty) void api.save();
    } else if (mod && key === 'e') {
      event.preventDefault();
      api.toggleMode();
    } else if (
      key === 'escape' &&
      !event.defaultPrevented &&
      file.mode === 'edit' &&
      viewerRef.current?.contains(event.target as Node)
    ) {
      api.setMode('preview');
    }
  };

  const toggleTree = () => {
    if (narrow) {
      setNarrowPane((pane) => (pane === 'tree' ? 'viewer' : 'tree'));
      return;
    }
    setTreeCollapsed((collapsed) => {
      const next = !collapsed;
      localStorage.setItem(TREE_COLLAPSED_KEY, next ? '1' : '0');
      return next;
    });
  };

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-testid="file-explorer"
      data-find-scope={watchId}
      onKeyDown={onKeyDown}
      onMouseDown={swallowSideButton}
      onMouseUp={onMouseUp}
      onAuxClick={swallowSideButton}
    >
      {/* 窄面板显示文件树时只是藏起内容区、不卸载：编辑器的未保存修改和撤销历史要留着。 */}
      <div
        ref={viewerRef}
        className={styles.viewerColumn}
        style={narrow && showTree ? { display: 'none' } : undefined}
        data-testid="file-viewer-column"
      >
        <FileTabBar
          root={tree.root}
          paths={tabs.paths}
          active={openPath}
          dirty={dirtyPaths}
          onActivate={onActivateTab}
          onClose={onCloseTab}
        />
        {mountedPaths.map((path) => (
          <FileTabPane
            key={path}
            workspace={workspace}
            path={path}
            active={path === openPath}
            root={tree.root}
            isDark={isDarkMode}
            confirm={confirm}
            nav={nav}
            findScope={path === openPath ? watchId : undefined}
            onOpenLink={openLink}
            register={registerApi}
            onSummary={onSummary}
          />
        ))}
        {openPath ? null : (
          <div className={styles.tabPane}>
            <FileViewer workspace={workspace} root={tree.root} api={IDLE_API} isDark={isDarkMode} nav={nav} />
          </div>
        )}
      </div>
      {!showTree ? (
        <div className={styles.treeRail}>
          <button
            type="button"
            className={styles.treeToggle}
            data-testid="file-explorer-tree-toggle"
            aria-expanded="false"
            aria-label="展开文件列表"
            onClick={toggleTree}
          >
            <PanelRightOpen size={16} />
          </button>
        </div>
      ) : (
        <>
          {narrow ? null : (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整文件树宽度"
              className={styles.splitter}
              data-testid="file-explorer-splitter"
              data-dragging={dragging}
              onPointerDown={startResize}
            />
          )}
          <div
            className={styles.treePane}
            style={narrow ? { flex: 1, minWidth: 0 } : { width: shownTreeWidth }}
            data-testid="file-explorer-tree"
            data-narrow={narrow ? 'true' : undefined}
            onPointerLeave={() => setHoverPath(null)}
          >
            <div className={styles.treeHeader}>
              <span>文件</span>
              <button
                type="button"
                className={styles.treeToggle}
                data-testid="file-explorer-tree-toggle"
                aria-expanded="true"
                aria-label="收起文件列表"
                onClick={toggleTree}
              >
                <PanelRightClose size={16} />
              </button>
            </div>
            <FileTree
              tree={tree}
              selectedPath={openPath}
              onOpen={(path) => {
                void openFile(path);
                if (narrow) setNarrowPane('viewer');
              }}
              onHoverPath={setHoverPath}
              contextMenu={treeMenu}
            />
            <FilePathBar root={tree.root} hoverPath={hoverPath} selectedPaths={openPath ? [openPath] : []} />
          </div>
        </>
      )}
    </div>
  );
}
