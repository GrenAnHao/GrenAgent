/**
 * 读工作区当前的 git HEAD。普通仓库读 `.git/HEAD`，worktree 先解开 `.git` 文件里的 gitdir 指针。
 * 返回 `ref + 换行 + 目标`；分离 HEAD 只有提交号。读不到就 undefined，不当成分支切换。
 */
import { isAbsolute, join } from 'node:path';

export interface GitHeadIo {
  read(path: string): string | undefined;
  isDirectory(path: string): boolean;
}

export type HeadAction = 'unknown' | 'record' | 'same' | 'changed';

/** 第一次看见 HEAD 只记下，不算切换；之后变了才是切换。读不到则什么都不做。 */
export function headAction(previous: string | undefined, next: string | undefined): HeadAction {
  if (!next) return 'unknown';
  if (previous === undefined) return 'record';
  return previous === next ? 'same' : 'changed';
}

export function readGitHead(root: string, io: GitHeadIo): string | undefined {
  const gitPath = join(root, '.git');
  let gitDir = gitPath;
  if (!io.isDirectory(gitPath)) {
    const pointer = io.read(gitPath);
    const target = pointer?.match(/^gitdir:\s*(.+)\s*$/m)?.[1];
    if (!target) return undefined;
    gitDir = isAbsolute(target) ? target : join(root, target);
  }
  const head = io.read(join(gitDir, 'HEAD'))?.trim();
  if (!head) return undefined;
  const ref = head.match(/^ref:\s*(\S+)\s*$/)?.[1];
  if (!ref) return head;
  const resolved = io.read(join(gitDir, ref))?.trim();
  return resolved ? `${ref}\n${resolved}` : ref;
}
