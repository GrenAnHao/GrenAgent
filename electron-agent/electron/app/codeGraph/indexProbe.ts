import { statSync } from 'node:fs';
import { join } from 'node:path';

export interface ProjectIndexState { workspace: string; indexed: boolean }

/** 该工作区是否已建立 CodeGraph 索引（存在 .codegraph 目录）。 */
export function isIndexed(workspace: string): boolean {
  if (!workspace.trim()) return false;
  try {
    return statSync(join(workspace, '.codegraph')).isDirectory();
  } catch {
    return false;
  }
}

/** 批量探测：空白路径被跳过，其余按输入顺序返回索引状态。 */
export function probeProjects(workspaces: string[]): ProjectIndexState[] {
  return workspaces
    .filter((workspace) => workspace.trim())
    .map((workspace) => ({ workspace, indexed: isIndexed(workspace) }));
}
