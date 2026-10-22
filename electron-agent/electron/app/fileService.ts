import { createHash } from 'node:crypto';
import { rawFs, rawFsPromises } from './rawFs.js';

// 工作区里的 .asar 只是文件：Electron 的 node:fs 会把它当目录打开并一直占着，见 rawFs.ts。
const { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, stat, writeFile } = rawFsPromises;
const { existsSync } = rawFs;
import { basename, dirname, join, relative, resolve } from 'node:path';
import { runSafeGit } from '../../../extensions/_shared/git-safe.js';

const MAX_DEPTH = 6;
const MAX_CHILDREN = 200;
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_BINARY_BYTES = 64 * 1024 * 1024;
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'target', '.pi', '__pycache__', '.next', 'coverage']);
/**
 * 文件浏览器按层列目录时跳过的目录。点开头的文件照常列出：.github、.gitignore 这类正是要看的。
 * .gren 是独立工作区的池目录（整份仓库副本），在主仓的文件树里只会混淆。
 */
const LISTING_SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'out', '.gren']);
const MAX_LISTING_ENTRIES = 5000;
/** 文件浏览器读文本的上限：更大的文件只读开头这么多，标成截断、只读。 */
const MAX_VIEW_BYTES = 5 * 1024 * 1024;
/** 判断二进制只看开头这么多字节里有没有 NUL，和 git 的 buffer_is_binary 同一条规则。 */
const BINARY_SNIFF_BYTES = 8000;

export interface FileNode {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  children: FileNode[] | null;
  git_status: string | null;
  size: number | null;
}

export interface BinaryFile {
  mime_type: string;
  data: string;
  size: number;
}

export interface DirEntry {
  name: string;
  /** 绝对路径（工作区根已 realpath）。 */
  path: string;
  isDir: boolean;
  size: number | null;
}

export interface DirListing {
  /** 列的是哪个目录（realpath 后的绝对路径）；列根目录时渲染层靠它认出变更事件里的根。 */
  dir: string;
  entries: DirEntry[];
  /** 条目超过上限时只返回前面这些。 */
  truncated: boolean;
}

export type FileView =
  | { kind: 'text'; content: string; size: number; truncated: boolean }
  | { kind: 'binary'; size: number };

export class FileService {
  private readonly dropped = new Set<string>();

  async tree(workspace: string, includeGitStatus: boolean): Promise<FileNode> {
    const root = await workspaceRoot(workspace);
    const tree = await buildTree(root, 0);
    if (includeGitStatus) applyGitStatus(tree, root, await gitStatus(root));
    return tree;
  }

  async read(workspace: string, path: string): Promise<string> {
    const target = await safeWorkspacePath(workspace, path, false);
    const metadata = await stat(target);
    if (metadata.size > MAX_TEXT_BYTES) throw new Error('File too large to preview (max 512KB)');
    return readFile(target, 'utf8');
  }

  /** 只读一层，目录在前、按名称自然排序；跳过符号链接和 LISTING_SKIPPED_DIRECTORIES。 */
  async listDir(workspace: string, dir: string): Promise<DirListing> {
    const target = await safeWorkspacePath(workspace, dir || '.', false);
    const kept = (await readdir(target, { withFileTypes: true }))
      .filter((entry) => !entry.isSymbolicLink() && !(entry.isDirectory() && isListingSkippedName(entry.name)))
      .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || NAME_ORDER.compare(left.name, right.name));
    const visible = kept.slice(0, MAX_LISTING_ENTRIES);
    const entries = await Promise.all(visible.map(async (entry): Promise<DirEntry> => {
      const path = join(target, entry.name);
      if (entry.isDirectory()) return { name: entry.name, path, isDir: true, size: null };
      const size = await stat(path).then((metadata) => metadata.size, () => null);
      return { name: entry.name, path, isDir: false, size };
    }));
    return { dir: target, entries, truncated: kept.length > visible.length };
  }

  /** 文件浏览器读文件：二进制只回大小；文本超过 MAX_VIEW_BYTES 只读开头并标成截断。 */
  async readForView(workspace: string, path: string): Promise<FileView> {
    const target = await safeWorkspacePath(workspace, path, false);
    const handle = await open(target, 'r');
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, MAX_VIEW_BYTES);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      const bytes = buffer.subarray(0, bytesRead);
      if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { kind: 'binary', size };
      // toString 保留 BOM，原样写回时不会把它弄丢。
      return { kind: 'text', content: bytes.toString('utf8'), size, truncated: size > bytesRead };
    } finally {
      await handle.close();
    }
  }

  /** 工作区内已存在的路径 → realpath；越界或不存在时抛错。 */
  async resolveExisting(workspace: string, path: string): Promise<string> {
    return safeWorkspacePath(workspace, path, false);
  }

  async write(workspace: string, path: string, content: string): Promise<void> {
    const target = await safeWorkspacePath(workspace, path, true);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, content);
    await rename(temporary, target);
  }

  async readBinary(workspace: string, path: string): Promise<BinaryFile> {
    return this.readBinaryPath(await safeWorkspacePath(workspace, path, false));
  }

  async registerDropped(paths: string[]): Promise<void> {
    if (this.dropped.size > 500) this.dropped.clear();
    for (const path of paths) {
      try {
        this.dropped.add(await realpath(path));
      } catch {
        // A non-existent drag target is intentionally ignored, matching the Tauri command.
      }
    }
  }

  async readDropped(path: string): Promise<BinaryFile> {
    const source = await this.allowedDropped(path);
    return this.readBinaryPath(source);
  }

  async importDropped(workspace: string, path: string): Promise<string> {
    const source = await this.allowedDropped(path);
    const metadata = await stat(source);
    if (metadata.size > MAX_BINARY_BYTES) throw new Error('File too large (max 64MB)');
    const root = await workspaceRoot(workspace);
    const name = basename(source);
    if (!name) throw new Error('invalid file name');
    const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
    const destinationDirectory = join(root, '.pi', 'dropped', hash);
    await mkdir(destinationDirectory, { recursive: true });
    await copyFile(source, join(destinationDirectory, name));
    return `.pi/dropped/${hash}/${name}`;
  }

  private async allowedDropped(path: string): Promise<string> {
    let canonical: string;
    try {
      canonical = await realpath(path);
    } catch {
      throw new Error('File does not exist');
    }
    if (!this.dropped.has(canonical)) throw new Error('File not in dropped allowlist');
    return canonical;
  }

  private async readBinaryPath(path: string): Promise<BinaryFile> {
    const metadata = await stat(path);
    if (metadata.size > MAX_BINARY_BYTES) throw new Error('File too large (max 64MB)');
    const bytes = await readFile(path);
    return { mime_type: mimeFromPath(path), data: bytes.toString('base64'), size: metadata.size };
  }
}

const NAME_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** 文件浏览器不列出、也不为之推送变更的目录名（node_modules 装包、git 命令会频繁改动它们）。 */
export function isListingSkippedName(name: string): boolean {
  return LISTING_SKIPPED_DIRECTORIES.has(name);
}

async function workspaceRoot(workspace: string): Promise<string> {
  try {
    return await realpath(workspace);
  } catch {
    throw new Error('workspace path does not exist');
  }
}

async function safeWorkspacePath(workspace: string, requested: string, allowMissing: boolean): Promise<string> {
  const root = await workspaceRoot(workspace);
  const candidate = resolve(root, requested);
  if (!within(root, candidate)) throw new Error('Path escapes workspace');
  if (!allowMissing || existsSync(candidate)) {
    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch {
      throw new Error('File does not exist');
    }
    if (!within(root, canonical)) throw new Error('Path escapes workspace');
    return canonical;
  }
  let parent = dirname(candidate);
  while (!existsSync(parent) && parent !== dirname(parent)) parent = dirname(parent);
  const canonicalParent = await realpath(parent);
  if (!within(root, canonicalParent)) throw new Error('Path escapes workspace');
  return candidate;
}

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('/') && !rel.startsWith('\\') && !rel.split(/[\\/]/).includes('..'));
}

async function buildTree(path: string, depth: number): Promise<FileNode> {
  const metadata = await lstat(path);
  const isDirectory = metadata.isDirectory();
  if (!isDirectory) {
    return { name: basename(path), path, kind: 'file', children: null, git_status: null, size: metadata.size };
  }
  let children: FileNode[] = [];
  if (depth < MAX_DEPTH) {
    const entries = (await readdir(path, { withFileTypes: true }))
      .filter((entry) => !entry.isSymbolicLink() && !skipEntry(entry.name, entry.isDirectory()))
      .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name))
      .slice(0, MAX_CHILDREN);
    children = await Promise.all(entries.map((entry) => buildTree(join(path, entry.name), depth + 1)));
  }
  return { name: basename(path) || 'workspace', path, kind: 'directory', children: children.length ? children : null, git_status: null, size: null };
}

function skipEntry(name: string, isDirectory: boolean): boolean {
  return name.startsWith('.') || (isDirectory && SKIPPED_DIRECTORIES.has(name));
}

/** 文件树每次加载都会跑，沙箱可能写过这个工作区：走 runSafeGit（挡住了哪些、没挡住哪些见 _shared/git-safe.ts 的头注释）。 */
async function gitStatus(workspace: string): Promise<Map<string, string>> {
  try {
    const { stdout } = await runSafeGit(workspace, ['status', '--porcelain']);
    return new Map(stdout.split(/\r?\n/).flatMap(parseGitStatus));
  } catch {
    return new Map();
  }
}

function parseGitStatus(line: string): Array<[string, string]> {
  if (line.length < 4) return [];
  const code = line.slice(0, 2);
  const raw = line.slice(3).trim();
  const path = raw.includes(' -> ') ? raw.split(' -> ').at(-1)! : raw;
  if (!path) return [];
  if (code === '??') return [[path.replaceAll('\\', '/'), 'untracked']];
  const status = code[1] === 'M' || code[1] === 'D' ? 'modified' : 'staged';
  return [[path.replaceAll('\\', '/'), status]];
}

function applyGitStatus(node: FileNode, root: string, statuses: Map<string, string>): void {
  if (node.kind === 'file') {
    const path = relative(root, node.path).replaceAll('\\', '/');
    node.git_status = statuses.get(path) ?? null;
  }
  node.children?.forEach((child) => applyGitStatus(child, root, statuses));
}

function mimeFromPath(path: string): string {
  switch (path.split('.').at(-1)?.toLowerCase()) {
    case 'png': return 'image/png'; case 'jpg': case 'jpeg': return 'image/jpeg'; case 'gif': return 'image/gif';
    case 'webp': return 'image/webp'; case 'ico': return 'image/x-icon'; case 'bmp': return 'image/bmp'; case 'svg': return 'image/svg+xml';
    case 'mp3': return 'audio/mpeg'; case 'wav': return 'audio/wav'; case 'ogg': case 'opus': return 'audio/ogg';
    case 'flac': return 'audio/flac'; case 'm4a': case 'aac': return 'audio/mp4'; case 'webm': return 'audio/webm';
    default: return 'application/octet-stream';
  }
}
