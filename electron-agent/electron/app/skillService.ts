import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { replacePreviewedFile } from './extensionFiles';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';

export interface SkillInfo { name: string; description: string; path: string; scope: string; disableModelInvocation?: boolean; }

const execFileAsync = promisify(execFile);

export class SkillService {
  constructor(private readonly home: string, private readonly agentDir = join(home, '.pi', 'agent')) {}

  async list(workspace?: string): Promise<SkillInfo[]> {
    const seen = new Set<string>();
    const result: SkillInfo[] = [];
    for (const [directory, scope] of this.directories(workspace)) {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const path = join(directory, entry.name);
        try { if (!(await lstat(join(path, 'SKILL.md'))).isFile()) continue; } catch { continue; }
        const info = await readSkillInfo(path, entry.name);
        const identity = scope + ':' + info.name;
        if (!seen.has(identity)) { seen.add(identity); result.push({ ...info, scope }); }
      }
    }
    return result.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'accent' }));
  }

  async create(rawName: string, description: string, body: string): Promise<SkillInfo> {
    const name = rawName.trim();
    validateName(name);
    const path = join(this.targetDirectory(), name);
    try { await lstat(path); throw new Error(`技能 "${name}" 已存在`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'SKILL.md'), buildSkillMarkdown(name, description, body));
    return { name, description: compact(description), path, scope: 'global' };
  }

  async checkedDirectory(path: string, workspace?: string): Promise<string> {
    if (!isAbsolute(path) || !this.directories(workspace).some(([root]) => relative(root, dirname(resolve(path))) === '')) {
      throw new Error('拒绝删除或修改：路径不在技能目录内');
    }
    if (!(await lstat(path)).isDirectory() || !(await lstat(join(path, 'SKILL.md'))).isFile()) {
      throw new Error('目标不是普通技能目录');
    }
    return resolve(path);
  }

  async detail(path: string, workspace?: string) {
    const target = await this.checkedDirectory(path, workspace);
    return { content: await readFile(join(target, 'SKILL.md'), 'utf8'), files: await directoryEntries(target) };
  }

  async files(path: string, folder: string, workspace?: string) {
    const root = await this.checkedDirectory(path, workspace);
    const parts = folder.split('/');
    if (parts.some((p) => !p || p === '.' || p === '..' || /[\\\\:]/.test(p))) throw new Error('无效的资源目录');
    let dir = root;
    for (const part of parts) {
      dir = join(dir, part);
      if (!(await lstat(dir)).isDirectory()) throw new Error('不能展开链接或非目录资源');
    }
    return directoryEntries(dir);
  }

  async save(path: string, original: string, content: string, workspace?: string) {
    const target = await this.checkedDirectory(path, workspace);
    await replacePreviewedFile(join(target, 'SKILL.md'), original, content);
  }

  async archive(path: string, workspace?: string): Promise<string> {
    const target = await this.checkedDirectory(path, workspace);
    const root = join(dirname(dirname(target)), 'skills-archive');
    await mkdir(root, { recursive: true });
    if (!(await lstat(root)).isDirectory()) throw new Error('归档位置不是普通目录');
    const slot = await mkdtemp(join(root, 'archive-'));
    const destination = join(slot, basename(target));
    try { await rename(target, destination); }
    catch (error) { await rmdir(slot).catch(() => {}); throw error; }
    return destination;
  }

  async remove(path: string, workspace?: string): Promise<void> {
    await rm(await this.checkedDirectory(path, workspace), { recursive: true });
  }

  async importDirectory(source: string): Promise<SkillInfo> {
    const sourcePath = await realpath(source).catch((error) => { throw new Error(`路径无效: ${String(error)}`); });
    if (!(await lstat(sourcePath)).isDirectory()) throw new Error('请选择一个技能目录');
    try { if (!(await lstat(join(sourcePath, 'SKILL.md'))).isFile()) throw new Error(); } catch { throw new Error('该目录缺少 SKILL.md，不是有效技能目录'); }
    const name = basename(sourcePath); validateName(name);
    const destination = await this.newDestination(name);
    await copySkillDirectory(sourcePath, destination);
    return readSkillInfo(destination, name);
  }

  async importFile(source: string): Promise<SkillInfo> {
    const sourcePath = await realpath(source).catch((error) => { throw new Error(`路径无效: ${String(error)}`); });
    if (!(await lstat(sourcePath)).isFile()) throw new Error('请选择一个文件');
    const filename = basename(sourcePath);
    const name = filename.toLowerCase() === 'skill.md' ? basename(join(sourcePath, '..')) : basename(filename, extname(filename));
    validateName(name);
    const destination = await this.newDestination(name);
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, 'SKILL.md'), await readFile(sourcePath));
    return readSkillInfo(destination, name);
  }

  async installZip(source: string): Promise<SkillInfo> {
    const listing = (await execFileAsync('tar', ['-tf', source], { windowsHide: true })).stdout.toString().split(/\r?\n/).filter(Boolean);
    if (listing.length > 5000) throw new Error(`zip 条目过多（${listing.length} > 5000），疑似异常包，已中止`);
    if (listing.some((entry) => entry.startsWith('/') || entry.startsWith('\\') || entry.split(/[\\/]/).includes('..'))) throw new Error('zip 包含非法路径');
    const temporary = await mkdtemp(join(tmpdir(), 'pi-skill-'));
    try {
      await execFileAsync('tar', ['-xf', source, '-C', temporary], { windowsHide: true });
      const root = await locateSkillRoot(temporary, basename(source, extname(source)));
      validateName(root.name);
      const destination = await this.newDestination(root.name);
      await copySkillDirectory(root.path, destination);
      return readSkillInfo(destination, root.name);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }

  async openDirectory(): Promise<string> { const directory = this.targetDirectory(); await mkdir(directory, { recursive: true }); return directory; }

  private directories(workspace?: string): Array<[string, string]> {
    const global: Array<[string, string]> = [[this.targetDirectory(), 'global'], [join(this.agentDir, 'skills'), 'global']];
    if (!workspace || !isAbsolute(workspace)) return global;
    return [[join(workspace, '.pi', 'skills'), 'project'], ...(!global.some(([dir]) => dir === join(workspace, '.agents', 'skills'))
      ? [[join(workspace, '.agents', 'skills'), 'project'] as [string, string]] : []), ...global];
  }
  private targetDirectory(): string { return join(this.home, '.agents', 'skills'); }
  private async newDestination(name: string): Promise<string> {
    const destination = join(this.targetDirectory(), name);
    try { await lstat(destination); throw new Error(`技能 "${name}" 已存在`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return destination;
  }
}

async function locateSkillRoot(temporary: string, fallbackName: string): Promise<{ path: string; name: string }> {
  try { if ((await lstat(join(temporary, 'SKILL.md'))).isFile()) return { path: temporary, name: fallbackName }; } catch { /* search children */ }
  const candidates = (await readdir(temporary, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  const matches: Array<{ path: string; name: string }> = [];
  for (const entry of candidates) {
    const path = join(temporary, entry.name);
    try { if ((await lstat(join(path, 'SKILL.md'))).isFile()) matches.push({ path, name: entry.name }); } catch { /* not a skill */ }
  }
  if (matches.length === 0) throw new Error('zip 内未找到 SKILL.md');
  if (matches.length > 1) throw new Error('zip 内包含多个技能，请逐个打包安装');
  return matches[0];
}

async function copySkillDirectory(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('技能目录不能包含符号链接');
    const from = join(source, entry.name); const to = join(destination, entry.name);
    if (entry.isDirectory()) await copySkillDirectory(from, to); else if (entry.isFile()) await cp(from, to, { force: false });
  }
}

async function readSkillInfo(path: string, fallbackName: string): Promise<SkillInfo> {
  const parsed = parseFrontmatter(await readFile(join(path, 'SKILL.md'), 'utf8'));
  return { name: parsed.name || fallbackName, description: parsed.description || '', path, scope: 'global', ...(parsed.disableModelInvocation && { disableModelInvocation: true }) };
}

function parseFrontmatter(text: string): { name?: string; description?: string; disableModelInvocation?: boolean } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/); if (lines[0] !== '---') return {};
  const end = lines.slice(1).indexOf('---'); if (end < 0) return {};
  const frontmatter = lines.slice(1, end + 1);
  // 先按真正的 YAML 解析：`description: >-` 这类折叠 / 多行写法逐行读只会得到 ">-"。
  try {
    const doc: unknown = parseYaml(frontmatter.join('\n'));
    if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
      const record = doc as Record<string, unknown>;
      const field = (key: string) => (typeof record[key] === 'string' ? compact(record[key] as string) : undefined);
      return { name: field('name'), description: field('description'), disableModelInvocation: record['disable-model-invocation'] === true };
    }
  } catch {
    // 手写的头部不一定是合法 YAML，退回逐行读，保持以前能读出来的照样能读。
  }
  const value = (key: string) => frontmatter.find((line) => line.startsWith(`${key}:`))?.slice(key.length + 1).trim();
  const unquote = (item: string | undefined) => item?.replace(/^['"]|['"]$/g, '');
  return { name: unquote(value('name')), description: unquote(value('description')) };
}

function validateName(name: string): void {
  if (!name) throw new Error('技能名称不能为空'); if (name.length > 64) throw new Error('技能名称过长（最多 64 字符）');
  if (name.startsWith('.')) throw new Error('技能名称不能以点开头'); if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error('技能名称只能包含字母、数字、连字符、下划线和点');
}
function compact(value: string): string { return value.trim().split(/\s+/).filter(Boolean).join(' '); }
function buildSkillMarkdown(name: string, description: string, body: string): string { const desc = compact(description).replaceAll('\\', '\\\\').replaceAll('"', '\\"'); return `---\nname: ${name}${desc ? `\ndescription: "${desc}"` : ''}\n---\n\n${body.trim() || `# ${name}`}\n`; }

async function directoryEntries(dir: string): Promise<string[]> {
  return (await readdir(dir, { withFileTypes: true }))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map((entry) => entry.name + (entry.isDirectory() ? '/' : ''));
}
