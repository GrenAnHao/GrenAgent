import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface SkillInfo { name: string; description: string; path: string; scope: string; }

const execFileAsync = promisify(execFile);

export class SkillService {
  constructor(private readonly home: string) {}

  async list(): Promise<SkillInfo[]> {
    const seen = new Set<string>();
    const result: SkillInfo[] = [];
    for (const directory of this.directories()) {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const path = join(directory, entry.name);
        try { await lstat(join(path, 'SKILL.md')); } catch { continue; }
        const info = await readSkillInfo(path, entry.name);
        if (!seen.has(info.name)) { seen.add(info.name); result.push(info); }
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

  async remove(path: string): Promise<void> {
    const target = await realpath(path).catch((error) => { throw new Error(`路径无效: ${String(error)}`); });
    const allowed = await Promise.all(this.directories().map(async (directory) => {
      try { return await realpath(directory); } catch { return null; }
    }));
    if (!allowed.some((base) => base && target !== base && within(base, target))) throw new Error('拒绝删除：路径不在全局技能目录内');
    try { if (!(await lstat(join(target, 'SKILL.md'))).isFile()) throw new Error(); } catch { throw new Error('拒绝删除：目标不是技能目录（缺少 SKILL.md）'); }
    await rm(target, { recursive: true, force: true });
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

  private directories(): string[] { return [this.targetDirectory(), join(this.home, '.pi', 'agent', 'skills')]; }
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
  return { name: parsed.name || fallbackName, description: parsed.description || '', path, scope: 'global' };
}

function parseFrontmatter(text: string): { name?: string; description?: string } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/); if (lines[0] !== '---') return {};
  const end = lines.slice(1).indexOf('---'); if (end < 0) return {};
  const frontmatter = lines.slice(1, end + 1); const value = (key: string) => frontmatter.find((line) => line.startsWith(`${key}:`))?.slice(key.length + 1).trim();
  const unquote = (item: string | undefined) => item?.replace(/^['"]|['"]$/g, '');
  return { name: unquote(value('name')), description: unquote(value('description')) };
}

function validateName(name: string): void {
  if (!name) throw new Error('技能名称不能为空'); if (name.length > 64) throw new Error('技能名称过长（最多 64 字符）');
  if (name.startsWith('.')) throw new Error('技能名称不能以点开头'); if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error('技能名称只能包含字母、数字、连字符、下划线和点');
}
function compact(value: string): string { return value.trim().split(/\s+/).filter(Boolean).join(' '); }
function buildSkillMarkdown(name: string, description: string, body: string): string { const desc = compact(description).replaceAll('\\', '\\\\').replaceAll('"', '\\"'); return `---\nname: ${name}${desc ? `\ndescription: "${desc}"` : ''}\n---\n\n${body.trim() || `# ${name}`}\n`; }
function within(base: string, target: string): boolean { const rel = relative(base, target); return rel !== '' && !rel.startsWith('..') && !rel.split(/[\\/]/).includes('..'); }
