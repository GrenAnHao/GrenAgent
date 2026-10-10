import { App } from 'antd';
import { useThemeMode } from 'antd-style';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { files } from '../../lib/files';
import { setDockCloseGuard } from '../dock/dockCloseGuards';
import { fileExplorerStyles as styles } from './fileExplorerStyles';
import { parentDir } from './fileKinds';
import { FileTree } from './FileTree';
import { FileViewer } from './FileViewer';
import { askUnsaved, registerUnsaved } from './unsavedChanges';
import { useElementSize } from './useElementSize';
import { useFileTree } from './useFileTree';
import { useOpenFile } from './useOpenFile';

const TREE_WIDTH_KEY = 'hermes-file-explorer-tree-width';
const DEFAULT_TREE_WIDTH = 240;
const MIN_TREE_WIDTH = 160;
const MIN_VIEWER_WIDTH = 240;

function readTreeWidth(): number {
  const stored = Number(localStorage.getItem(TREE_WIDTH_KEY));
  return Number.isFinite(stored) && stored >= MIN_TREE_WIDTH ? stored : DEFAULT_TREE_WIDTH;
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

/** 项目文件浏览器：左边文件树，右边内容（markdown 预览 / 代码只读，都可切到编辑）。 */
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
  const [dragging, setDragging] = useState(false);
  // 存下来的宽度是上次的；Dock 变窄时按当前宽度收一收，内容区至少留 MIN_VIEWER_WIDTH。
  const { width: rootWidth } = useElementSize(rootRef);
  const shownTreeWidth = rootWidth > 0 ? clampTreeWidth(treeWidth, rootWidth) : treeWidth;

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (!root) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const left = root.getBoundingClientRect().left;
    const total = root.getBoundingClientRect().width;
    let latest = shownTreeWidth;
    setDragging(true);
    const move = (e: globalThis.PointerEvent) => {
      latest = clampTreeWidth(e.clientX - left, total);
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

  return (
    <div ref={rootRef} className={styles.root} data-testid="file-explorer" onKeyDown={onKeyDown}>
      <div className={styles.treePane} style={{ width: shownTreeWidth }}>
        <FileTree tree={tree} selectedPath={openPath} onOpen={(path) => void api.open(path)} />
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整文件树宽度"
        className={styles.splitter}
        data-testid="file-explorer-splitter"
        data-dragging={dragging}
        onPointerDown={startResize}
      />
      <div ref={viewerRef} style={{ display: 'flex', flex: 1, minWidth: 0, minHeight: 0 }}>
        <FileViewer workspace={workspace} root={tree.root} api={api} isDark={isDarkMode} />
      </div>
    </div>
  );
}
