import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export interface FileStatus { path: string; status: 'modified' | 'staged' | 'untracked'; }
export interface BranchInfo { name: string; isCurrent: boolean; upstream: string | null; ahead: number; behind: number; }
export interface GitBranches { current: string; branches: BranchInfo[]; }
export interface GitLogEntry { hash: string; shortHash: string; parents: string[]; author: string; subject: string; timestamp: number; refs: string[]; }

export class GitService {
  async status(workspacePath: string): Promise<FileStatus[]> {
    if (!await isRepository(workspacePath)) return [];
    const output = await runGit(workspacePath, ['status', '--porcelain']);
    return output.split(/\r?\n/).flatMap(parsePorcelainLine);
  }

  async diff(workspacePath: string, filePath: string): Promise<string> {
    await this.assertRepository(workspacePath);
    const tracked = await runGit(workspacePath, ['diff', '--', filePath]);
    if (tracked.trim()) return tracked;
    const directory = await mkdtemp(join(tmpdir(), 'electron-agent-git-empty-'));
    const empty = join(directory, 'empty');
    await writeFile(empty, '');
    try {
      return await runGitAllowFailure(workspacePath, ['diff', '--no-index', '--', empty, filePath]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async branches(workspacePath: string): Promise<GitBranches> {
    if (!await isRepository(workspacePath)) return { current: '', branches: [] };
    const current = (await runGit(workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const output = await runGit(workspacePath, ['branch', '--format', '%(refname:short)%1f%(HEAD)%1f%(upstream:short)%1f%(upstream:track)']);
    return { current, branches: output.split(/\r?\n/).flatMap(parseBranch) };
  }

  async checkout(workspacePath: string, branch: string): Promise<void> {
    await this.assertRepository(workspacePath);
    await runGit(workspacePath, ['checkout', branch]);
  }

  async createBranch(workspacePath: string, name: string, checkout: boolean): Promise<void> {
    await this.assertRepository(workspacePath);
    await runGit(workspacePath, checkout ? ['checkout', '-b', name] : ['branch', name]);
  }

  /**
   * 分页拉提交历史：本地分支 + 远端分支 + tag + HEAD（不含 stash）。
   * `--date-order` 保证子提交总在父提交之前，前端 lane 布局依赖这一点；顺序稳定，`--skip` 翻页不乱。
   */
  async logGraph(workspacePath: string, limit: number | null | undefined, skip = 0): Promise<GitLogEntry[]> {
    if (!await isRepository(workspacePath)) return [];
    const args = ['log', '--branches', '--remotes', '--tags', 'HEAD', '--date-order', '-n', String(limit ?? 40)];
    if (skip > 0) args.push('--skip', String(skip));
    args.push('--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%ct%x1f%s%x1f%D', '--');
    const output = await runGit(workspacePath, args);
    return output.split(/\r?\n/).flatMap(parseLogEntry);
  }

  private async assertRepository(workspacePath: string): Promise<void> {
    if (!await isRepository(workspacePath)) throw new Error('not a git repository');
  }
}

async function isRepository(workspacePath: string): Promise<boolean> {
  try { await access(join(workspacePath, '.git')); return true; } catch { return false; }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFile('git', args, { cwd, windowsHide: true });
    return stdout;
  } catch (error) {
    const detail = String((error as { stderr?: string }).stderr ?? '').trim();
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
}

async function runGitAllowFailure(cwd: string, args: string[]): Promise<string> {
  try { return (await execFile('git', args, { cwd, windowsHide: true })).stdout; }
  catch (error) { return String((error as { stdout?: string }).stdout ?? ''); }
}

function parsePorcelainLine(line: string): FileStatus[] {
  if (line.length < 4) return [];
  const code = line.slice(0, 2);
  const path = (line.includes(' -> ') ? line.split(' -> ').at(-1)! : line.slice(3)).trim();
  if (!path) return [];
  const status: FileStatus['status'] = code === '??' ? 'untracked'
    : /[MD]/.test(code[1] ?? '') ? 'modified'
      : /[MADRC]/.test(code[0] ?? '') ? 'staged' : 'modified';
  return [{ path, status }];
}

function parseBranch(line: string): BranchInfo[] {
  const [nameRaw, headRaw, upstreamRaw, trackRaw] = line.split('\x1f');
  const name = nameRaw?.trim();
  if (!name) return [];
  const track = trackRaw?.trim().replace(/^\[|\]$/g, '') ?? '';
  const ahead = Number(track.match(/ahead (\d+)/)?.[1] ?? 0);
  const behind = Number(track.match(/behind (\d+)/)?.[1] ?? 0);
  const upstream = upstreamRaw?.trim();
  return [{ name, isCurrent: headRaw?.trim() === '*', upstream: upstream || null, ahead, behind }];
}

function parseLogEntry(line: string): GitLogEntry[] {
  const [hash, shortHash, parentsRaw, author, timestampRaw, subject, refsRaw] = line.split('\x1f');
  if (!hash?.trim()) return [];
  return [{ hash: hash.trim(), shortHash: shortHash?.trim() ?? '', parents: parentsRaw?.trim().split(/\s+/).filter(Boolean) ?? [], author: author ?? '', timestamp: Number(timestampRaw?.trim() ?? 0), subject: subject ?? '', refs: refsRaw?.split(', ').map((ref) => ref.trim()).filter(Boolean) ?? [] }];
}
