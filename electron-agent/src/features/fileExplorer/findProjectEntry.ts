import { files } from '../../lib/files';
import { baseName, parentDir } from './fileKinds';

export type ProjectEntry = { status: 'file' | 'dir' | 'missing'; path: string };

/**
 * 链接指向的路径在磁盘上是文件、目录还是不存在。只列父目录这一层（和展开文件树同一个接口），不读文件内容。
 * 先精确匹配名字，再不区分大小写匹配（Windows / macOS 上 `readme.md` 能指到 `README.md`）。
 * 父目录列表被截断（条目太多）又没找到时不下结论，当文件交给打开流程自己报错。
 */
export async function findProjectEntry(workspace: string, path: string): Promise<ProjectEntry> {
  const dir = parentDir(path);
  if (dir === path) return { status: 'dir', path };
  const name = baseName(path);
  try {
    const listing = await files.listDir(workspace, dir);
    const lower = name.toLowerCase();
    const hit =
      listing.entries.find((entry) => entry.name === name) ??
      listing.entries.find((entry) => entry.name.toLowerCase() === lower);
    if (hit) return { status: hit.isDir ? 'dir' : 'file', path: hit.path };
    return { status: listing.truncated ? 'file' : 'missing', path };
  } catch {
    return { status: 'missing', path };
  }
}
