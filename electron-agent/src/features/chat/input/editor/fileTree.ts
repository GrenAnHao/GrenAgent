import type { FileNode } from '../../../../lib/files';

/** 扁平化后的工作区条目（用于 `@` 文件提及搜索）。 */
export interface FlatFile {
  name: string;
  /** 相对工作区根的路径（正斜杠）。 */
  path: string;
  isDirectory: boolean;
}

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** 工作区根的绝对路径（正斜杠、无尾斜杠）。拖拽落入文件时据此换算相对路径。 */
export function workspaceRootPath(root: FileNode): string {
  return norm(root.path);
}

/** 把 get_file_tree 的树拍平成相对路径列表（跳过根节点本身）。 */
export function flattenFileTree(root: FileNode): FlatFile[] {
  const rootPrefix = norm(root.path);
  const out: FlatFile[] = [];
  const walk = (node: FileNode) => {
    const abs = norm(node.path);
    let rel = abs;
    if (abs === rootPrefix) {
      rel = '';
    } else if (abs.startsWith(`${rootPrefix}/`)) {
      rel = abs.slice(rootPrefix.length + 1);
    }
    if (rel) out.push({ name: node.name, path: rel, isDirectory: node.kind === 'directory' });
    node.children?.forEach(walk);
  };
  walk(root);
  return out;
}

function isSubsequence(q: string, s: string): boolean {
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) {
    if (s[j] === q[i]) i += 1;
  }
  return i === q.length;
}

function scoreFile(f: FlatFile, q: string): number {
  const name = f.name.toLowerCase();
  const path = f.path.toLowerCase();
  if (name === q) return 100;
  if (name.startsWith(q)) return 80;
  if (name.includes(q)) return 60;
  if (path.includes(q)) return 40;
  if (isSubsequence(q, path)) return 20;
  return 0;
}

/** 按查询过滤 + 排序；空查询时返回最浅层的条目。 */
export function filterFiles(allFiles: FlatFile[], query: string, limit = 50): FlatFile[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [...allFiles]
      .sort(
        (a, b) =>
          a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path),
      )
      .slice(0, limit);
  }
  return allFiles
    .map((f) => ({ f, score: scoreFile(f, q) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.f.path.length - b.f.path.length)
    .slice(0, limit)
    .map((s) => s.f);
}
