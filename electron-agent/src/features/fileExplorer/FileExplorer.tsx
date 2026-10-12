import { App } from 'antd';
import { useThemeMode } from 'antd-style';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useElementMeasure } from '../../hooks/useElementMeasure';
import { files } from '../../lib/files';
import { setDockCloseGuard } from '../dock/dockCloseGuards';
import { fileExplorerStyles as styles } from './fileExplorerStyles';
import { parentDir } from './fileKinds';
import { FileTree } from './FileTree';
import { FileViewer } from './FileViewer';
import { askUnsaved, registerUnsaved } from './unsavedChanges';
import { useFileTree } from './useFileTree';
import { useOpenFile } from './useOpenFile';

const TREE_WIDTH_KEY = 'hermes-file-explorer-tree-width';
const TREE_COLLAPSED_KEY = 'hermes-file-explorer-tree-collapsed';
const DEFAULT_TREE_WIDTH = 240;
const MIN_TREE_WIDTH = 160;
const MIN_VIEWER_WIDTH = 240;

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

export interface FileExplorerProps {
  workspace: string;
  /** 标签 id：目录监听、关闭守卫、未保存登记都按它区分。 */
  watchId: string;
}

/** 项目文件浏览器：左边内容（markdown 预览 / 代码只读，都可切到编辑），右边文件树，文件树可以收起。 */
export function FileExplorer({ workspace, watchId }: FileExplorerProps) {
  const { modal } = App.useApp();
  const { isDarkMode } = useThemeMode();
  const confirm = useCallback((fileName: string) => askUnsaved(modal, fileName), [modal]);
  const api = useOpenFile(workspace, confirm);
  const openPath = 'path' in api.file ? api.file.path : null;
  const tree = useFileTree(workspace, watchId, openPath ? parentDir(openPath) : null);
  const { refreshDirs } = tree;
  const { onFilesChanged, isDirty, resolveUnsaved } = api;

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

  // 快捷键只在这个标签里生效：Ctrl+S 保存，Ctrl+E 切换预览 / 编辑，Esc 退出编辑。
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
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
    setTreeCollapsed((collapsed) => {
      const next = !collapsed;
      localStorage.setItem(TREE_COLLAPSED_KEY, next ? '1' : '0');
      return next;
    });
  };

  return (
    <div ref={rootRef} className={styles.root} data-testid="file-explorer" onKeyDown={onKeyDown}>
      <div ref={viewerRef} style={{ display: 'flex', flex: 1, minWidth: 0, minHeight: 0 }}>
        <FileViewer workspace={workspace} root={tree.root} api={api} isDark={isDarkMode} />
      </div>
      {treeCollapsed ? (
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
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="调整文件树宽度"
            className={styles.splitter}
            data-testid="file-explorer-splitter"
            data-dragging={dragging}
            onPointerDown={startResize}
          />
          <div className={styles.treePane} style={{ width: shownTreeWidth }} data-testid="file-explorer-tree">
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
            <FileTree tree={tree} selectedPath={openPath} onOpen={(path) => void api.open(path)} />
          </div>
        </>
      )}
    </div>
  );
}
