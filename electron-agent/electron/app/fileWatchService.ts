import { watch as fsWatch, type FSWatcher, type WatchListener } from 'node:fs';
import { join } from 'node:path';

/** 合并一阵子里的变更再推给渲染层，保存、git checkout 这类一次改很多文件的操作只推一两批。 */
const FLUSH_DELAY_MS = 120;
/** 每个文件浏览器标签最多同时监听的目录数（只监听树里展开了的目录）。 */
const MAX_WATCHED_DIRS = 256;

export interface FileChangeBatch {
  workspace: string;
  /** 有变更的目录（绝对路径），渲染层据此重新列出这一层。 */
  dirs: string[];
  /** 平台报出文件名时的具体路径；Windows 偶尔不给文件名，这时只有 dirs。 */
  paths: string[];
}

type Emit = (batch: FileChangeBatch) => void;
type ResolveDir = (workspace: string, dir: string) => Promise<string>;
type WatchFn = (dir: string, listener: WatchListener<string>) => FSWatcher;

interface WatchGroup {
  workspace: string;
  emit: Emit;
  watchers: Map<string, FSWatcher>;
  pendingDirs: Set<string>;
  pendingPaths: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  /** setDirs 是异步的：只有最后一次调用的结果生效。 */
  generation: number;
  closed: boolean;
}

/**
 * 文件浏览器的目录监听：每个展开的目录各开一个非递归 fs.watch。
 * 不用递归监听整个工作区：Linux 上递归监听要给 node_modules 里每个目录挂 inotify，
 * 而浏览器只关心展开了的那几层。
 */
export class FileWatchService {
  private readonly groups = new Map<string, WatchGroup>();

  constructor(
    private readonly resolveDir: ResolveDir,
    private readonly ignoreName: (name: string) => boolean = () => false,
    private readonly watchFn: WatchFn = (dir, listener) => fsWatch(dir, { persistent: false }, listener),
  ) {}

  /** 把 key 名下监听的目录换成 dirs：新增的开监听，不再需要的关掉。越界或已不存在的目录跳过。 */
  async setDirs(key: string, workspace: string, dirs: string[], emit: Emit): Promise<void> {
    const group = this.groupFor(key, workspace, emit);
    const generation = ++group.generation;
    const wanted = new Set<string>();
    for (const dir of dirs.slice(0, MAX_WATCHED_DIRS)) {
      try {
        wanted.add(await this.resolveDir(workspace, dir));
      } catch {
        // 目录刚被删掉或越界：不监听，渲染层下次列目录时会看到。
      }
    }
    if (generation !== group.generation || group.closed) return;

    for (const [dir, watcher] of group.watchers) {
      if (wanted.has(dir)) continue;
      watcher.close();
      group.watchers.delete(dir);
    }
    for (const dir of wanted) {
      if (group.watchers.has(dir)) continue;
      this.open(group, dir);
    }
  }

  /** 关掉 key 名下的全部监听（标签关闭）。 */
  clear(key: string): void {
    const group = this.groups.get(key);
    if (!group) return;
    group.closed = true;
    if (group.timer) clearTimeout(group.timer);
    for (const watcher of group.watchers.values()) watcher.close();
    this.groups.delete(key);
  }

  /** 关掉 key 以 prefix 开头的全部监听（窗口销毁）。 */
  clearPrefix(prefix: string): void {
    for (const key of [...this.groups.keys()]) {
      if (key.startsWith(prefix)) this.clear(key);
    }
  }

  watchedDirs(key: string): string[] {
    return [...(this.groups.get(key)?.watchers.keys() ?? [])];
  }

  private groupFor(key: string, workspace: string, emit: Emit): WatchGroup {
    const existing = this.groups.get(key);
    if (existing && existing.workspace === workspace) {
      existing.emit = emit;
      return existing;
    }
    if (existing) this.clear(key);
    const group: WatchGroup = {
      workspace,
      emit,
      watchers: new Map(),
      pendingDirs: new Set(),
      pendingPaths: new Set(),
      timer: null,
      generation: 0,
      closed: false,
    };
    this.groups.set(key, group);
    return group;
  }

  private open(group: WatchGroup, dir: string): void {
    let watcher: FSWatcher;
    try {
      watcher = this.watchFn(dir, (_eventType, filename) => {
        if (filename && this.ignoreName(filename)) return;
        this.record(group, dir, filename ? join(dir, filename) : null);
      });
    } catch {
      return;
    }
    // Windows 上被监听的目录本身被删时会报 EPERM：关掉这一个，让渲染层重新列目录。
    watcher.on('error', () => {
      watcher.close();
      if (group.watchers.get(dir) === watcher) group.watchers.delete(dir);
      this.record(group, dir, null);
    });
    group.watchers.set(dir, watcher);
  }

  private record(group: WatchGroup, dir: string, path: string | null): void {
    group.pendingDirs.add(dir);
    if (path) group.pendingPaths.add(path);
    if (group.timer) return;
    group.timer = setTimeout(() => this.flush(group), FLUSH_DELAY_MS);
  }

  private flush(group: WatchGroup): void {
    group.timer = null;
    if (group.closed || group.pendingDirs.size === 0) return;
    const batch: FileChangeBatch = {
      workspace: group.workspace,
      dirs: [...group.pendingDirs],
      paths: [...group.pendingPaths],
    };
    group.pendingDirs.clear();
    group.pendingPaths.clear();
    group.emit(batch);
  }
}
