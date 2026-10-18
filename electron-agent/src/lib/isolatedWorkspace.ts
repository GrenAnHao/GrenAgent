// 独立工作区（A 轨）的路径约定，与 extensions/_shared/isolated-workspace.ts 的 isolatedPathParts 同规则。
// 渲染层没有 node:path，这里只按字符串判断形状；是不是真的托管、目录还在不在，用 pi.probeIsolatedWorkspaces 问主进程。

const ISOLATED_PATH = /^(.*?)[\\/]+\.gren[\\/]+worktrees[\\/]+([a-z0-9][a-z0-9-]{0,63})[\\/]*$/i;

export interface IsolatedPath {
  /** 主仓根（保留原分隔符）。 */
  parentRoot: string;
  id: string;
  /** 宿主建的分支名，固定是 gren/<id>。 */
  branch: string;
}

export function isolatedPathOf(path: string | null | undefined): IsolatedPath | null {
  if (!path) return null;
  const match = ISOLATED_PATH.exec(path);
  if (!match || !match[1]) return null;
  const id = match[2]!;
  if (id !== id.toLowerCase()) return null;
  return { parentRoot: match[1], id, branch: `gren/${id}` };
}

/** 主进程抛错文本里带的机器码（ISOLATED_BUSY / ISOLATED_UNSAVED），没有就是 undefined。 */
export function isolatedErrorCode(error: unknown): 'ISOLATED_BUSY' | 'ISOLATED_UNSAVED' | undefined {
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes('ISOLATED_BUSY')) return 'ISOLATED_BUSY';
  if (text.includes('ISOLATED_UNSAVED')) return 'ISOLATED_UNSAVED';
  return undefined;
}

/** IPC 错误会带上 "Error invoking remote method ..." 前缀和机器码，给人看时去掉。 */
export function isolatedErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
    .replace(/ISOLATED_(BUSY|UNSAVED):\s*/, '');
}
