import { getDetails } from '../tools/toolUtils';

/**
 * 会话的工作目录可以被 `working_directory` / `create_worktree` 切走（extensions/_shared/session-cwd.ts），
 * 切走之后 write / edit / present 里的相对路径都按新目录解析，而界面上的 workspace 一直是项目根（会话头 cwd）。
 * 这里从工具结果里还原「这次切到了哪」，让界面和工具用同一个基准目录。
 */
export function cwdAfterTool(toolName: string, status: 'running' | 'done' | 'error', result: unknown): string | undefined {
  if (status !== 'done') return undefined;
  const details = getDetails(result);
  if (!details) return undefined;
  // working_directory：details.cwd；create_worktree：details.path（新 worktree 目录，随后会话已切进去）。
  const value = toolName === 'working_directory' ? details.cwd : toolName === 'create_worktree' ? details.path : undefined;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export interface ResolvedSessionFile {
  /** 主机上的绝对路径，正斜杠。 */
  absolute: string;
  /** 能读到这个文件的根目录：优先项目工作区，其次会话目录，都不在里面时取文件所在目录。 */
  root: string;
}

const ABSOLUTE = /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/;

function slashes(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/');
}

function isWithin(root: string, target: string): boolean {
  const base = slashes(root).replace(/\/+$/, '').toLowerCase();
  const full = slashes(target).toLowerCase();
  return full === base || full.startsWith(`${base}/`);
}

/**
 * 把工具参数里的文件路径解析成绝对路径和可读根目录。
 * 相对路径按 cwd（会话当时的工作目录，没有切过就是项目工作区）解析；绝对路径原样用。
 * 含 `..` 的、没有工作区的，返回 null。
 */
export function resolveSessionFile(workspace: string, cwd: string | undefined, path: string): ResolvedSessionFile | null {
  const raw = path.trim();
  if (!workspace.trim() || !raw) return null;
  const base = (cwd?.trim() || workspace).replace(/[\\/]+$/, '');
  const absolute = slashes(ABSOLUTE.test(raw) ? raw : `${base}/${raw.replace(/^[\\/]+/, '')}`);
  if (absolute.split('/').includes('..')) return null;
  const known = [workspace, cwd].find((root): root is string => !!root?.trim() && isWithin(root, absolute));
  if (known) return { absolute, root: known };
  const slash = absolute.lastIndexOf('/');
  return { absolute, root: slash > 0 ? absolute.slice(0, slash) : '/' };
}
