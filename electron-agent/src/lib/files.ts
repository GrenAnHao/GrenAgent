import { invoke, listen, type UnlistenFn } from '../platform/runtime';

export interface FileNode {
  name: string;
  path: string;
  kind: 'file' | 'directory' | string;
  children?: FileNode[] | null;
  git_status?: string | null;
  size?: number | null;
}

export interface BinaryFile {
  mime_type: string;
  data: string;
  size: number;
}

export interface FileStatus {
  path: string;
  status: string;
}

export interface DirEntry {
  name: string;
  /** 绝对路径（主进程已 realpath 工作区根）。 */
  path: string;
  isDir: boolean;
  size: number | null;
}

export interface DirListing {
  /** 列的是哪个目录（realpath 后的绝对路径）。 */
  dir: string;
  entries: DirEntry[];
  truncated: boolean;
}

export type FileView =
  | { kind: 'text'; content: string; size: number; truncated: boolean }
  | { kind: 'binary'; size: number };

/** 主进程目录监听推来的一批变更（只含该标签监听的、展开了的目录）。 */
export interface FilesChangedEvent {
  watchId: string;
  workspace: string;
  dirs: string[];
  paths: string[];
}

export const files = {
  getTree: (workspace: string, includeGitStatus = false) =>
    invoke<FileNode>('get_file_tree', { workspace, includeGitStatus }),

  read: (workspace: string, path: string) =>
    invoke<string>('read_file', { workspace, path }),

  readBinary: (workspace: string, path: string) =>
    invoke<BinaryFile>('read_file_binary', { workspace, path }),

  /** 注册「拖放白名单」：仅这些被用户主动拖入的绝对路径之后可被 readDropped 读取。 */
  registerDroppedFiles: (paths: string[]) => invoke<void>('register_dropped_files', { paths }),

  /** 读取拖放白名单内的文件（支持工作区外文件，传绝对路径）。 */
  readDropped: (path: string) => invoke<BinaryFile>('read_dropped_file', { path }),

  /** 把拖放白名单内的文件复制进工作区 .pi/dropped/，返回相对路径（二进制文件 @ 引用后 AI 用工具读取）。 */
  importDropped: (workspace: string, path: string) =>
    invoke<string>('import_dropped_file', { workspace, path }),

  write: (workspace: string, path: string, content: string) =>
    invoke<void>('write_file', { workspace, path, content }),

  gitStatus: (workspace: string) =>
    invoke<FileStatus[]>('get_git_status', { workspacePath: workspace }),

  gitDiff: (workspace: string, filePath: string) =>
    invoke<string>('get_git_diff', { workspacePath: workspace, filePath }),

  /** 只列一层；dir 传空串表示工作区根。 */
  listDir: (workspace: string, dir: string) => invoke<DirListing>('list_dir', { workspace, dir }),

  /** 文件浏览器读文件：二进制只回大小，超过 5MB 的文本只读开头并标成截断。 */
  readView: (workspace: string, path: string) => invoke<FileView>('read_file_view', { workspace, path }),

  /** 用系统默认程序打开工作区内的文件（主进程校验不越界）。 */
  openExternal: (workspace: string, path: string) => invoke<void>('open_workspace_file', { workspace, path }),

  /** 把 watchId 名下监听的目录换成 dirs（非递归，空串表示根）。 */
  watchDirs: (workspace: string, watchId: string, dirs: string[]) =>
    invoke<void>('watch_workspace_dirs', { workspace, watchId, dirs }),

  unwatchDirs: (watchId: string) => invoke<void>('unwatch_workspace_dirs', { watchId }),

  onChanged: (handler: (event: FilesChangedEvent) => void): Promise<UnlistenFn> =>
    listen<FilesChangedEvent>('files://changed', (e) => handler(e.payload)),
};
