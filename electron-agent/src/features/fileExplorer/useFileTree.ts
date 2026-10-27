import { useCallback, useEffect, useRef, useState } from 'react';
import { files } from '../../lib/files';
import { dirsToWatch, withListing, type DirMap } from './treeModel';

/** 展开、收起后合并一下再告诉主进程要监听哪些目录。 */
const WATCH_SYNC_DELAY_MS = 200;

export interface FileTreeState {
  /** 工作区根（realpath 后）；根还没列出来时是 null。 */
  root: string | null;
  dirs: DirMap;
  expanded: string[];
  /** 条目太多、只列了前一部分的目录。 */
  truncatedDirs: ReadonlySet<string>;
  error: string | null;
  setExpanded: (keys: string[]) => void;
  loadDir: (dir: string) => Promise<void>;
  /** 重新列出这些目录里已经加载过的那些（目录监听推来变更时调用）。 */
  refreshDirs: (dirs: readonly string[]) => void;
  reload: () => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 文件树数据：只列根，展开时再列那一层；展开着的目录交给主进程监听。
 * extraWatch 是树之外也要盯着的目录（打开着的文件标签所在的目录）。
 */
export function useFileTree(workspace: string, watchId: string, extraWatch: readonly string[]): FileTreeState {
  const [root, setRoot] = useState<string | null>(null);
  const [dirs, setDirs] = useState<DirMap>(() => new Map());
  const [expanded, setExpanded] = useState<string[]>([]);
  const [truncatedDirs, setTruncatedDirs] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const dirsRef = useRef(dirs);
  dirsRef.current = dirs;
  // 调用方每次渲染都可能给新数组：按内容比，不按引用。
  const extraWatchKey = extraWatch.join('\n');

  const markTruncated = useCallback((dir: string, truncated: boolean) => {
    setTruncatedDirs((prev) => {
      if (prev.has(dir) === truncated) return prev;
      const next = new Set(prev);
      if (truncated) next.add(dir);
      else next.delete(dir);
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setRoot(null);
    files
      .listDir(workspace, '')
      .then((listing) => {
        if (cancelled) return;
        setRoot(listing.dir);
        setDirs(new Map([[listing.dir, listing.entries]]));
        setExpanded([]);
        markTruncated(listing.dir, listing.truncated);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [workspace, attempt, markTruncated]);

  const loadDir = useCallback(
    async (dir: string) => {
      const listing = await files.listDir(workspace, dir);
      setDirs((prev) => withListing(prev, dir, listing.entries));
      markTruncated(dir, listing.truncated);
    },
    [workspace, markTruncated],
  );

  const refreshDirs = useCallback(
    (changed: readonly string[]) => {
      for (const dir of changed) {
        if (!dirsRef.current.has(dir)) continue;
        loadDir(dir).catch(() => {
          // 目录自己被删了：父目录的变更会把它从树里摘掉。
        });
      }
    },
    [loadDir],
  );

  useEffect(() => {
    if (!root) return;
    const wanted = dirsToWatch(root, dirs, expanded);
    for (const dir of extraWatchKey ? extraWatchKey.split('\n') : []) {
      if (!wanted.includes(dir)) wanted.push(dir);
    }
    const timer = setTimeout(() => {
      files.watchDirs(workspace, watchId, wanted).catch(() => {});
    }, WATCH_SYNC_DELAY_MS);
    return () => clearTimeout(timer);
  }, [workspace, watchId, root, dirs, expanded, extraWatchKey]);

  useEffect(
    () => () => {
      files.unwatchDirs(watchId).catch(() => {});
    },
    [watchId],
  );

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  return { root, dirs, expanded, truncatedDirs, error, setExpanded, loadDir, refreshDirs, reload };
}
