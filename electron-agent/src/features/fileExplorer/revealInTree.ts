import { ancestorDirs } from './treeModel';
import type { FileTreeState } from './useFileTree';

/**
 * 在文件树里把 path 露出来：祖先目录没列过的依次列出来，再一并展开。
 * 外部「打开这个文件」请求和 markdown 内链共用这一份。getTree 每次现取：中间有 await，闭包里的 tree 会过期。
 * includeSelf 用于 path 本身是目录（链接指向目录）：连它也展开。列目录失败就停在已经能露出的那一层。
 */
export async function revealInTree(
  getTree: () => FileTreeState,
  path: string,
  options: { includeSelf?: boolean } = {},
): Promise<void> {
  const root = getTree().root;
  if (!root) return;
  const targets = [...ancestorDirs(root, path), ...(options.includeSelf ? [path] : [])];
  for (const dir of targets) {
    if (getTree().dirs.has(dir)) continue;
    try {
      await getTree().loadDir(dir);
    } catch {
      return;
    }
  }
  const { expanded, setExpanded } = getTree();
  const missing = targets.filter((dir) => !expanded.includes(dir));
  if (missing.length > 0) setExpanded([...expanded, ...missing]);
}
