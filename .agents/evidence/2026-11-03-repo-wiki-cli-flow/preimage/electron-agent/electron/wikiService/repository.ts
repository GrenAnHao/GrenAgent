import type { WikiOperation, WikiRunContext } from './contracts';
import { REFERENCE_PROFILE } from './referenceProfiles';
import { scanKnowledgeSnapshot, userSafeDirectoryArgs } from '../../vendor/repo-wiki/packages/core/src/scanner';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { devNull } from 'node:os';
const exec = promisify(execFile);
const gitEnvironment = () => { const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))); return { ...env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : devNull }; };
export function sourceScope(plan: Record<string, unknown>): { include: string[]; exclude: string[] } {
  const list = (value: unknown, fallback: string[]) => value === undefined ? fallback : Array.isArray(value) && value.every(x => typeof x === 'string' && x.length > 0) ? [...new Set(value as string[])].sort() : (() => { throw new Error('INVALID_SOURCE_SCOPE'); })();
  return { include: list(plan.include, ['**']), exclude: list(plan.exclude, []) };
}
export interface RepositoryInputs { readme: string; readmePresent: boolean; branch: string; tree: string; repositoryName: string; count: number; manifest: Array<{ path: string; hash: string }> }
export async function repositoryInputs(root: string, plan: Record<string, unknown> = {}, locale = 'zh', signal?: AbortSignal): Promise<RepositoryInputs> {
  const scope = sourceScope(plan);
  const scan = await scanKnowledgeSnapshot(root, { ...scope, language: locale }, signal);
  if (scan.coverage.partial) throw new Error('SOURCE_COVERAGE_INCOMPLETE');
  if (scan.git.kind === 'error') throw new Error('GIT_PROBE_FAILED');
  const readme = scan.files.find(file => !file.path.includes('/') && /^readme(?:[._-][a-z0-9-]+)?(?:\.[a-z0-9]+)?$/i.test(file.path));
  return { readme: readme?.content ?? '', readmePresent: !!readme, branch: scan.identity.branch, tree: scan.files.map(file => file.path).join('\n'), repositoryName: scan.name, count: scan.files.length, manifest: scan.files.map(file => ({ path: file.path, hash: file.hash })) };
}
export async function assertCleanTarget(root: string, target: string, allowedPaths: Set<string>): Promise<void> {
  if (!/^[0-9a-f]{40,64}$/i.test(target)) throw new Error('GIT_TARGET_REQUIRED');
  try {
    const opts = { encoding: 'utf8' as const, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: gitEnvironment() };
    const head = (await exec('git', [...userSafeDirectoryArgs(), '-C', root, 'rev-parse', 'HEAD'], opts)).stdout.trim();
    if (head.toLowerCase() !== target.toLowerCase()) throw new Error('TARGET_WORKTREE_MISMATCH');
    const status = (await exec('git', [...userSafeDirectoryArgs(), '-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], opts)).stdout;
    const records = status.split('\0').filter(Boolean);
    for (let i = 0; i < records.length; i++) { const record = records[i]; const name = record.slice(3); if (allowedPaths.has(name)) throw new Error('DIRTY_WORKTREE_REQUIRES_REVIEW'); if (/[RC]/.test(record.slice(0, 2))) { const old = records[++i]; if (old && allowedPaths.has(old)) throw new Error('DIRTY_WORKTREE_REQUIRES_REVIEW'); } }
  } catch (error) {
    if (error instanceof Error && ['TARGET_WORKTREE_MISMATCH', 'DIRTY_WORKTREE_REQUIRES_REVIEW'].includes(error.message)) throw error;
    throw new Error('GIT_TARGET_UNAVAILABLE');
  }
}
export interface GitDelta { files: string[]; changedFileCount: number; fileChanges: string; commitMessages: string; applyCommits: number; dropCommits: number; changedCommits: number }
interface GitCommit { hash: string; author: string; date: string; message: string; direction: 'apply' | 'drop' }
interface FileChange { status: string; path: string; oldPath?: string }
export function formatCommitMessages(apply: GitCommit[], drop: GitCommit[], totals: { apply: number; drop: number }): string {
  let output = '', used = 0;
  const estimate = (text: string) => text.length <= 3 ? 1 : Math.floor(text.length / 3);
  const group = (items: GitCommit[], heading: string, label: string) => {
    if (!items.length) return; output += heading; used += estimate(heading);
    for (let i = 0; i < items.length; i++) {
      const item = items[i], max = REFERENCE_PROFILE.git.commitMessageMaxTokens * 3;
      const message = item.message.length > max ? `${item.message.slice(0, max)}... [truncated]` : item.message;
      const formatted = `${i + 1}. [${item.direction.toUpperCase()}] ${item.hash.slice(0, 8)}\n   Message: ${message}\n${item.author ? `   Author: ${item.author}\n` : ''}${item.date ? `   Date: ${item.date}\n` : ''}\n`;
      if (used + estimate(formatted) > REFERENCE_PROFILE.git.commitDiffTotalMaxTokens) { const note = `\n[Note: Truncated. Showing ${i} of ${items.length} ${label} commits due to token limit]\n`; output += note; used += estimate(note); break; }
      output += formatted; used += estimate(formatted);
    }
  };
  group(apply, '=== APPLY COMMITS (current changes to document) ===\n\n', 'apply');
  if (drop.length && used < REFERENCE_PROFILE.git.commitDiffTotalMaxTokens) group(drop, '\n=== DROP COMMITS (changes no longer in codebase - consider removing from docs) ===\n\n', 'drop');
  if (apply.length < totals.apply || drop.length < totals.drop) output += `\n[Note: Commit list truncated. Showing ${apply.length} of ${totals.apply} apply commits and ${drop.length} of ${totals.drop} drop commits]\n`;
  return output;
}
export function formatFileChanges(changes: FileChange[], baseline: string, target: string): string {
  if (!changes.length) return '';
  return `Changes from ${baseline.slice(0, 8)} to ${target.slice(0, 8)}\n${changes.length} files changed\n\nFiles changed:\n` + changes.map(change => { const name = ({ A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied' } as Record<string, string>)[change.status[0]] ?? 'Modified'; return `  ${name}: ${change.oldPath ? `${change.oldPath} -> ` : ''}${change.path}\n`; }).join('');
}
export async function gitDelta(root: string, baseline: string, target: string, allowedPaths: Set<string>): Promise<GitDelta> {
  if (!/^[0-9a-f]{40,64}$/i.test(baseline) || !/^[0-9a-f]{40,64}$/i.test(target)) throw new Error('GIT_BASELINE_REQUIRED');
  const git = async (...args: string[]) => (await exec('git', [...userSafeDirectoryArgs(), '--literal-pathspecs', '-C', root, ...args], { maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', windowsHide: true, env: gitEnvironment() })).stdout;
  try {
    const mergeBase = (await git('merge-base', baseline, target)).trim();
    const counts = (await git('rev-list', '--left-right', '--count', `${baseline}...${target}`)).trim().split(/\s+/).map(Number);
    const data = (await git('diff', '--name-status', '-z', '-M', baseline, target, '--')).split('\0');
    const changes: FileChange[] = [];
    for (let i = 0; i < data.length && data[i];) { const status = data[i++], first = data[i++]; if (!first) throw new Error('INVALID_GIT_DIFF'); const renamed = /^[RC]/.test(status); const next = renamed ? data[i++] : first; if (!next) throw new Error('INVALID_GIT_DIFF'); changes.push({ status, path: next, ...(renamed ? { oldPath: first } : {}) }); }
    const relevant = changes.flatMap(change => { const current = allowedPaths.has(change.path), old = !!change.oldPath && allowedPaths.has(change.oldPath); if (current && (!change.oldPath || old)) return [change]; if (current) return [{ status: 'A', path: change.path }]; if (old) return [{ status: 'D', path: change.oldPath! }]; return []; });
    const commits = async (commit: string, direction: 'apply' | 'drop', max: number): Promise<GitCommit[]> => (await git('log', `-n${max}`, '--format=%H%x00%an%x00%aI%x00%B%x01', commit, `^${mergeBase}`)).split('\x01').flatMap(record => { const clean = record.replace(/^\n/, ''); if (!clean) return []; const [hash, author, date, message] = clean.split('\0'); return hash && author && date ? [{ hash, author, date, message: (message ?? '').trimEnd(), direction }] : []; });
    const apply = await commits(target, 'apply', REFERENCE_PROFILE.git.maxApplyCommits), drop = counts[0] ? await commits(baseline, 'drop', REFERENCE_PROFILE.git.maxDropCommits) : [];
    return { files: relevant.map(change => change.path), changedFileCount: changes.length, fileChanges: formatFileChanges(relevant, baseline, target), commitMessages: formatCommitMessages(apply, drop, { apply: counts[1], drop: counts[0] }), dropCommits: counts[0], applyCommits: counts[1], changedCommits: counts[0] + counts[1] };
  } catch { throw new Error('GIT_BASELINE_UNAVAILABLE'); }
}

/** Pin the scanner manifest and reject changes when resuming or publishing. */
export async function freezeRepository(operation: WikiOperation, context: WikiRunContext): Promise<RepositoryInputs> {
  const repo = await repositoryInputs(operation.repositoryRoot, operation.plan, operation.locale, context.signal);
  if (repo.branch !== operation.branch) throw new Error('SOURCE_IDENTITY_CHANGED');
  const prior = context.checkpoints().find(c => c.stage === 'source' && c.itemId === '' && c.disposition === 'done');
  if (prior && JSON.stringify(prior.parsed) !== JSON.stringify(repo.manifest)) throw new Error('SOURCE_SNAPSHOT_CHANGED');
  if (!prior) context.checkpoint({ stage: 'source', itemId: '', disposition: 'done', raw: '', parsed: repo.manifest });
  return repo;
}

/** Freeze both the read baseline and the partition value that publication must replace. */
export function pinPriorPublication(operation: WikiOperation, context: WikiRunContext) {
  type Pin = { sourceId: string | null; expectedId: string | null };
  const checkpoints = context.checkpoints();
  let pin = checkpoints.find(c => c.stage === 'prior-publication' && c.itemId === operation.id && c.disposition === 'done')?.parsed as Pin | undefined;
  if (!pin) {
    const current = context.published();
    if (operation.action === 'repair' && operation.parentOperationId) {
      const parent = checkpoints.find(c => c.stage === 'prior-publication' && c.itemId === operation.parentOperationId && c.disposition === 'done')?.parsed as Pin | undefined;
      if (!parent) throw new Error('REPAIR_BASELINE_MISSING');
      const currentId = current?.id ?? null;
      if (current?.operationId !== operation.parentOperationId && currentId !== parent.expectedId) throw new Error('BASELINE_CHANGED');
      pin = { sourceId: parent.sourceId, expectedId: currentId };
    } else pin = { sourceId: current?.id ?? null, expectedId: current?.id ?? null };
    context.checkpoint({ stage: 'prior-publication', itemId: operation.id, disposition: 'done', raw: '', parsed: pin });
  }
  const source = pin.sourceId ? context.publication(pin.sourceId) : undefined;
  if (pin.sourceId && !source) throw new Error('BASELINE_UNAVAILABLE');
  return { source, expectedId: pin.expectedId };
}
