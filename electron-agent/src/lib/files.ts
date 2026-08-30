import { invoke } from '../platform/runtime';

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
};
