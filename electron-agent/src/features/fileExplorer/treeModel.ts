import type { DirEntry } from '../../lib/files';

/** 已列出的目录：目录绝对路径 → 这一层的条目。没列过的目录不在表里，展开时才去列。 */
export type DirMap = ReadonlyMap<string, readonly DirEntry[]>;

export interface TreeNode {
  key: string;
  entry: DirEntry;
  isLeaf: boolean;
  /** 只有列过的目录才有；undefined 表示还没加载。 */
  children?: TreeNode[];
}

export function isDescendant(path: string, ancestor: string): boolean {
  return path.length > ancestor.length && path.startsWith(ancestor) && (path[ancestor.length] === '/' || path[ancestor.length] === '\\');
}

/** 从 dir 往下拼出树。visible 给了就只留其中的节点（搜索时用）。 */
export function buildTree(dir: string, dirs: DirMap, visible?: ReadonlySet<string>): TreeNode[] {
  const entries = dirs.get(dir) ?? [];
  const nodes: TreeNode[] = [];
  for (const entry of entries) {
    if (visible && !visible.has(entry.path)) continue;
    const loaded = entry.isDir && dirs.has(entry.path);
    nodes.push({
      key: entry.path,
      entry,
      isLeaf: !entry.isDir,
      ...(loaded ? { children: buildTree(entry.path, dirs, visible) } : {}),
    });
  }
  return nodes;
}

/** 换掉 dir 这一层的条目；新列表里已经没有的子目录，连同它们下面列过的内容一起丢掉。 */
export function withListing(dirs: DirMap, dir: string, entries: readonly DirEntry[]): Map<string, readonly DirEntry[]> {
  const next = new Map(dirs);
  const kept = new Set(entries.filter((e) => e.isDir).map((e) => e.path));
  for (const old of dirs.get(dir) ?? []) {
    if (!old.isDir || kept.has(old.path)) continue;
    for (const key of dirs.keys()) {
      if (key === old.path || isDescendant(key, old.path)) next.delete(key);
    }
  }
  next.set(dir, entries);
  return next;
}

export interface TreeSearch {
  /** 命中的节点和它们的所有祖先。 */
  visible: Set<string>;
  /** 需要展开的祖先目录。 */
  expand: Set<string>;
  matches: number;
}

/** 只在已加载的节点里按文件名找（不区分大小写）；query 为空返回 null。 */
export function searchTree(root: string, dirs: DirMap, query: string): TreeSearch | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  const visible = new Set<string>();
  const expand = new Set<string>();
  let matches = 0;
  const walk = (dir: string, ancestors: string[]) => {
    for (const entry of dirs.get(dir) ?? []) {
      if (entry.name.toLowerCase().includes(needle)) {
        matches += 1;
        visible.add(entry.path);
        for (const a of ancestors) {
          visible.add(a);
          expand.add(a);
        }
      }
      if (entry.isDir && dirs.has(entry.path)) walk(entry.path, [...ancestors, entry.path]);
    }
  };
  walk(root, []);
  return { visible, expand, matches };
}

/** 需要监听的目录：根 + 展开着且列过的目录。 */
export function dirsToWatch(root: string, dirs: DirMap, expanded: Iterable<string>): string[] {
  const out = [root];
  for (const key of expanded) {
    if (key !== root && dirs.has(key)) out.push(key);
  }
  return out;
}
