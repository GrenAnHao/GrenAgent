import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { parse, stringify } from 'yaml';
import type { WikiBucket, WikiDiagnostic, WikiPage, WikiSourceRef } from './wikiContracts';

export interface WikiDiskPage extends WikiPage { sources: string[]; sourcePath: string; workspace: string }

export interface WikiPageDocument {
  workspace: string;
  page: string;
  title: string;
  content: string;
  sourcePath: string;
  sources: string[];
  path: string;
  locked: boolean;
  updatedAt: number;
}

interface WorkspaceManifest { version: 1; workspace: string; legacyExported: string[] }
export interface WikiFilePublication { commit(): void; rollback(): void }

/** Reject path syntax that can escape or alias files on either Windows or POSIX. */
export function wikiRelativePath(value: string): string {
  if (!value || isAbsolute(value) || win32.isAbsolute(value)) throw new Error('invalid Wiki path');
  const parts = value.replace(/\\/g, '/').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('invalid Wiki path');
  }
  return parts.join('/');
}

export function wikiHash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

export class WikiFiles {
  readonly root: string;

  constructor(root: string) {
    if (!root?.trim()) throw new Error('Wiki rootDir is required');
    mkdirSync(resolve(root), { recursive: true });
    if (lstatSync(resolve(root)).isSymbolicLink()) throw new Error('Wiki root path is a symbolic link');
    this.root = realpathSync(resolve(root));
  }

  workspaceDir(workspace: string): string {
    if (!workspace.trim()) throw new Error('Wiki workspace is required');
    return this.bucketDir(wikiHash(workspace));
  }

  filePath(workspace: string, path: string): string {
    return this.filePathAt(wikiHash(workspace), path);
  }

  bucketDir(bucket: WikiBucket | string): string {
    const key = typeof bucket === 'string' ? bucket : bucket.storageKey;
    if (!/^(?:[a-f0-9]{64}|kb-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(key)) throw new Error('invalid Wiki storage bucket');
    return this.safePath(key);
  }

  filePathAt(bucket: WikiBucket | string, path: string): string {
    const directory = this.bucketDir(bucket);
    return this.safePath(`${basename(directory)}/${wikiRelativePath(path)}`);
  }

  private safePath(path: string): string {
    this.assertRoot();
    const parts = wikiRelativePath(path).split('/');
    let target = this.root;
    if (lstatSync(target).isSymbolicLink()) throw new Error('Wiki root path is a symbolic link');
    for (const part of parts) {
      target = join(target, part);
      try {
        if (lstatSync(target).isSymbolicLink()) throw new Error('Wiki path contains a symbolic link');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const rel = relative(this.root, target);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Wiki path escapes storage');
    return target;
  }

  private assertRoot(): void {
    if (realpathSync(this.root) !== this.root) throw new Error('Wiki root path changed through a symbolic link');
  }

  manifest(workspace: string, create = false): WorkspaceManifest | undefined {
    const path = this.filePath(workspace, 'workspace.json');
    if (!existsSync(path)) {
      if (!create) return undefined;
      const value: WorkspaceManifest = { version: 1, workspace, legacyExported: [] };
      this.write(workspace, 'workspace.json', JSON.stringify(value, null, 2));
      return value;
    }
    const value = JSON.parse(readFileSync(path, 'utf8')) as WorkspaceManifest;
    if (value.version !== 1 || value.workspace !== workspace || !Array.isArray(value.legacyExported) || !value.legacyExported.every((id) => typeof id === 'string')) throw new Error('invalid Wiki workspace mapping');
    return value;
  }

  markLegacyExported(workspace: string, page: string): void {
    const value = this.manifest(workspace, true)!;
    if (value.legacyExported.includes(page)) return;
    value.legacyExported.push(page);
    this.write(workspace, 'workspace.json', JSON.stringify(value, null, 2));
  }

  pagePath(workspace: string, page: string): string {
    const logical = wikiRelativePath(page);
    const stem = logical.replace(/\.md$/i, '');
    let path = `wiki/${stem}--${wikiHash(page).slice(0, 16)}.md`;
    // Preserve any manually created file occupying the generated filename.
    while (existsSync(this.filePath(workspace, path))) path = `wiki/${stem}--${wikiHash(page).slice(0, 16)}-${randomUUID()}.md`;
    return path;
  }

  sourcePath(workspace: string, sourcePath: string): string {
    const path = isAbsolute(sourcePath) || win32.isAbsolute(sourcePath) ? relative(resolve(workspace), resolve(sourcePath)) : sourcePath;
    return wikiRelativePath(path);
  }

  snapshotPath(sourcePath: string, content: string): string {
    const extension = extname(sourcePath);
    const stem = extension ? sourcePath.slice(0, -extension.length) : sourcePath;
    return `raw/sources/${stem}--${wikiHash(`${sourcePath}\n${content}`).slice(0, 16)}${extension || '.txt'}`;
  }

  read(workspace: string, path: string): WikiPageDocument | undefined {
    if (!wikiRelativePath(path).startsWith('wiki/')) throw new Error('invalid Wiki page path');
    const absolute = this.filePath(workspace, path);
    let text: string;
    try { text = readFileSync(absolute, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n(?:\r?\n)?)?/.exec(text);
    if (/^---(?:\r?\n|$)/.test(text) && !match) throw new Error('unclosed Wiki frontmatter');
    const value: unknown = match ? parse(match[1]) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid Wiki frontmatter');
    const meta = value as Record<string, unknown>;
    if (meta.locked !== undefined && typeof meta.locked !== 'boolean') throw new Error('invalid Wiki locked frontmatter; expected boolean');
    if (meta.workspace !== undefined && meta.workspace !== workspace) throw new Error('Wiki workspace metadata mismatch');
    const content = match ? text.slice(match[0].length) : text;
    const page = typeof meta.pageId === 'string' ? meta.pageId : typeof meta.page === 'string' ? meta.page : path.slice('wiki/'.length);
    wikiRelativePath(page);
    const sourcePath = typeof meta.sourcePath === 'string' ? meta.sourcePath : page;
    const updated = typeof meta.updatedAt === 'number' ? meta.updatedAt : Date.parse(String(meta.updatedAt));
    return {
      workspace, page, content, sourcePath, path: absolute,
      title: typeof meta.title === 'string' ? meta.title : /^#\s+(.+)$/m.exec(content)?.[1] ?? basename(page, '.md'),
      sources: Array.isArray(meta.sources) ? meta.sources.filter((source): source is string => typeof source === 'string') : [],
      locked: meta.locked === true,
      updatedAt: Number.isFinite(updated) ? updated : statSync(absolute).mtimeMs,
    };
  }

  render(page: WikiPageDocument, legacyContentHash?: string): string {
    return `---\n${stringify({ workspace: page.workspace, page: page.page, title: page.title, sourcePath: page.sourcePath, sources: page.sources, updatedAt: new Date(page.updatedAt).toISOString(), locked: page.locked, ...(legacyContentHash === undefined ? {} : { legacyContentHash }) })}---\n\n${page.content}`;
  }

  readText(workspace: string, path: string): string { return readFileSync(this.filePath(workspace, path), 'utf8'); }

  readTextAt(bucket: WikiBucket | string, path: string): string { return readFileSync(this.filePathAt(bucket, path), 'utf8'); }

  checkBucket(bucket: WikiBucket): void {
    const manifest = JSON.parse(this.readTextAt(bucket, 'library.json')) as Record<string, unknown>;
    if (manifest.version !== 1 || manifest.kbId !== bucket.kbId || manifest.storageKey !== bucket.storageKey) throw new Error('invalid Wiki library manifest mapping');
    if (bucket.legacyWorkspace) this.manifest(bucket.legacyWorkspace);
  }

  writeAt(bucket: WikiBucket | string, path: string, content: string): void { this.publishAt(bucket, path, content).commit(); }

  write(workspace: string, path: string, content: string): void {
    this.publish(workspace, path, content).commit();
  }

  /** Keep an existing byte-for-byte backup until the caller commits its index transaction. */
  publish(workspace: string, path: string, content: string): WikiFilePublication {
    return this.publishAt(wikiHash(workspace), path, content);
  }

  publishAt(bucket: WikiBucket | string, path: string, content: string, expectedHash?: string | null): WikiFilePublication {
    const target = this.filePathAt(bucket, path);
    mkdirSync(dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    const backup = existsSync(target) ? `${target}.${randomUUID()}.rollback` : undefined;
    try {
      writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx' });
      if (backup) copyFileSync(target, backup, constants.COPYFILE_EXCL);
      this.filePathAt(bucket, path);
      if (expectedHash !== undefined) {
        const actualHash = existsSync(target) ? createHash('sha256').update(readFileSync(target)).digest('hex') : null;
        if (actualHash !== expectedHash) throw new Error('VERSION_CONFLICT: Wiki file changed; version conflict');
      }
      renameSync(temp, target);
    } catch (error) {
      if (backup) rmSync(backup, { force: true });
      throw error;
    } finally { rmSync(temp, { force: true }); }
    return {
      commit: () => { if (backup) { try { rmSync(backup, { force: true }); } catch { /* Harmless recovery copy; never indexed as Markdown. */ } } },
      rollback: () => {
        this.filePathAt(bucket, path);
        if (backup) renameSync(backup, target);
        else rmSync(target, { force: true });
      },
    };
  }

  remove(workspace: string, path: string): void { rmSync(this.filePath(workspace, path), { force: true }); }

  removeAt(bucket: WikiBucket | string, path: string): void { rmSync(this.filePathAt(bucket, path), { force: true }); }

  deleteBucketContent(bucket: WikiBucket): void {
    for (const path of ['wiki', 'raw']) {
      const target = this.filePathAt(bucket, path);
      const bucketPath = this.bucketDir(bucket);
      if (dirname(target) !== bucketPath) throw new Error('Wiki delete path escapes bucket');
      rmSync(target, { recursive: true, force: true });
    }
  }

  readAt(bucket: WikiBucket, path: string): WikiDiskPage | undefined {
    if (!wikiRelativePath(path).startsWith('wiki/')) throw new Error('invalid Wiki page path');
    const absolute = this.filePathAt(bucket, path);
    let bytes: Buffer;
    try { bytes = readFileSync(absolute); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    const text = bytes.toString('utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n(?:\r?\n)?)?/.exec(text);
    if (/^---(?:\r?\n|$)/.test(text) && !match) throw new Error('unclosed Wiki frontmatter');
    const value: unknown = match ? parse(match[1]) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid Wiki frontmatter');
    const meta = value as Record<string, unknown>;
    if (meta.locked !== undefined && typeof meta.locked !== 'boolean') throw new Error('invalid Wiki locked frontmatter; expected boolean');
    if (meta.kbId !== undefined && meta.kbId !== bucket.kbId) throw new Error('Wiki kbId metadata mismatch');
    if (meta.workspace !== undefined && meta.workspace !== bucket.legacyWorkspace) throw new Error('Wiki workspace metadata mismatch');
    if (meta.pageId !== undefined && (typeof meta.pageId !== 'string' || meta.kbId !== bucket.kbId)) throw new Error('invalid Wiki pageId frontmatter');
    if (meta.revision !== undefined && (!Number.isSafeInteger(meta.revision) || Number(meta.revision) < 0)) throw new Error('invalid Wiki revision frontmatter');
    if (meta.autoSourceId !== undefined && typeof meta.autoSourceId !== 'string') throw new Error('invalid Wiki autoSourceId frontmatter');
    const refs = meta.sourceRefs ?? [];
    if (!Array.isArray(refs) || !refs.every((ref) => ref && typeof ref.sourceId === 'string' && Number.isSafeInteger(ref.revision) && ref.revision >= 0)) throw new Error('invalid Wiki sourceRefs frontmatter');
    if (meta.sources !== undefined && (!Array.isArray(meta.sources) || !meta.sources.every((source) => typeof source === 'string'))) throw new Error('invalid Wiki sources frontmatter');
    const content = match ? text.slice(match[0].length) : text;
    const pageId = typeof meta.pageId === 'string' ? meta.pageId : typeof meta.page === 'string' ? meta.page : path.slice(5);
    wikiRelativePath(pageId);
    const updated = typeof meta.updatedAt === 'number' ? meta.updatedAt : Date.parse(String(meta.updatedAt));
    return {
      kbId: bucket.kbId, pageId, title: typeof meta.title === 'string' ? meta.title : /^#\s+(.+)$/m.exec(content)?.[1] ?? basename(pageId, '.md'),
      content, path: absolute, sourceRefs: refs as WikiSourceRef[], locked: meta.locked === true,
      ...(typeof meta.autoSourceId === 'string' ? { autoSourceId: meta.autoSourceId } : {}),
      revision: Number(meta.revision ?? 0), contentHash: createHash('sha256').update(bytes).digest('hex'), lifecycle: 'active', epoch: 0,
      updatedAt: Number.isFinite(updated) ? updated : statSync(absolute).mtimeMs,
      sources: (meta.sources ?? []) as string[], sourcePath: typeof meta.sourcePath === 'string' ? meta.sourcePath : pageId,
      workspace: bucket.legacyWorkspace ?? '',
    };
  }

  renderAt(page: WikiPage, legacy?: { sources: string[]; sourcePath: string; workspace: string }): string {
    return `---\n${stringify({ kbId: page.kbId, pageId: page.pageId, title: page.title, sourceRefs: page.sourceRefs, revision: page.revision, locked: page.locked,
      ...(page.autoSourceId ? { autoSourceId: page.autoSourceId } : {}), updatedAt: new Date(page.updatedAt).toISOString(), ...(legacy ?? {}) })}---\n\n${page.content}`;
  }

  scanBucket(bucket: WikiBucket): { pages: WikiDiskPage[]; diagnostics: WikiDiagnostic[] } {
    const pages: WikiDiskPage[] = []; const diagnostics: WikiDiagnostic[] = []; const seen = new Set<string>();
    const fail = (path: string, error: unknown, code = 'PAGE_PARSE_FAILED') => diagnostics.push({ code, kbId: bucket.kbId, path, message: String(error) });
    try { this.checkBucket(bucket); }
    catch (error) {
      return { pages, diagnostics: [{ code: 'INVALID_MANIFEST', kbId: bucket.kbId, path: join(this.root, bucket.storageKey, 'library.json'), message: String(error) }] };
    }
    const walk = (path: string): void => {
      let absolute: string;
      try {
        absolute = this.filePathAt(bucket, path);
        if (!existsSync(absolute)) return;
        for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const child = `${path}/${entry.name}`;
          if (entry.isSymbolicLink()) { fail(join(absolute, entry.name), 'symbolic link skipped', 'UNSAFE_LINK'); continue; }
          if (entry.isDirectory()) walk(child);
          else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
            try {
              const page = this.readAt(bucket, child); if (!page) continue;
              if (seen.has(page.pageId)) { fail(join(absolute, entry.name), 'duplicate page ID', 'DUPLICATE_PAGE_ID'); continue; }
              seen.add(page.pageId); pages.push(page);
            } catch (error) { fail(join(absolute, entry.name), error, error instanceof Error && error.message.includes('kbId metadata mismatch') ? 'KB_ID_MISMATCH' : 'PAGE_PARSE_FAILED'); }
          }
        }
      } catch (error) { fail(join(this.root, bucket.storageKey, path), error, 'BUCKET_SCAN_FAILED'); }
    };
    walk('wiki'); return { pages, diagnostics };
  }

  deleteWorkspace(workspace: string): void {
    for (const path of ['wiki', 'raw']) rmSync(this.filePath(workspace, path), { recursive: true, force: true });
  }

  scan(workspace?: string): { pages: WikiPageDocument[]; diagnostics: string[]; failedBuckets: Set<string> } {
    this.assertRoot();
    const pages: WikiPageDocument[] = [];
    const diagnostics: string[] = [];
    const failedBuckets = new Set<string>();
    const workspaces: string[] = [];
    if (workspace) {
      try {
        if (this.manifest(workspace)) workspaces.push(workspace);
        else if (existsSync(this.workspaceDir(workspace))) throw new Error('Wiki workspace mapping is missing');
      } catch (error) { failedBuckets.add(wikiHash(workspace)); diagnostics.push(`${workspace}: ${String(error)}`); }
    }
    else for (const entry of readdirSync(this.root)) {
      if (!/^[a-f0-9]{64}$/.test(entry)) continue;
      try {
        const mapping = JSON.parse(readFileSync(this.safePath(`${entry}/workspace.json`), 'utf8')) as WorkspaceManifest;
        if (typeof mapping.workspace !== 'string' || wikiHash(mapping.workspace) !== entry) throw new Error('invalid Wiki workspace mapping');
        this.manifest(mapping.workspace);
        workspaces.push(mapping.workspace);
      } catch (error) { failedBuckets.add(entry); diagnostics.push(`${entry}: ${String(error)}`); }
    }
    const seen = new Set<string>();
    for (const current of workspaces) {
      const walk = (path: string): void => {
        try {
          const absolute = this.filePath(current, path);
          if (!existsSync(absolute)) return;
          for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const child = `${path}/${entry.name}`;
            if (entry.isSymbolicLink()) { failedBuckets.add(wikiHash(current)); diagnostics.push(`${current}/${child}: symbolic link skipped`); continue; }
            if (entry.isDirectory()) walk(child);
            else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
              try {
                const page = this.read(current, child);
                if (!page) continue;
                const key = JSON.stringify([current, page.page]);
                if (seen.has(key)) { failedBuckets.add(wikiHash(current)); diagnostics.push(`${current}/${child}: duplicate page ID`); continue; }
                seen.add(key);
                pages.push(page);
              } catch (error) { failedBuckets.add(wikiHash(current)); diagnostics.push(`${current}/${child}: ${String(error)}`); }
            }
          }
        } catch (error) { failedBuckets.add(wikiHash(current)); diagnostics.push(`${current}/${path}: ${String(error)}`); }
      };
      walk('wiki');
    }
    return { pages, diagnostics, failedBuckets };
  }
}
