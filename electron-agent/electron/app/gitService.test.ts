import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { GitService } from './gitService';

const execFile = promisify(execFileCallback);
const directories: string[] = [];

afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function repository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'electron-agent-git-'));
  directories.push(directory);
  await execFile('git', ['init'], { cwd: directory });
  await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: directory });
  await execFile('git', ['config', 'user.name', 'Test User'], { cwd: directory });
  await writeFile(join(directory, 'tracked.txt'), 'initial\n');
  await execFile('git', ['add', 'tracked.txt'], { cwd: directory });
  await execFile('git', ['commit', '-m', 'initial'], { cwd: directory });
  return directory;
}

describe('GitService', () => {
  it('reports tracked modifications and untracked files, including an untracked diff', async () => {
    const workspace = await repository();
    await writeFile(join(workspace, 'tracked.txt'), 'changed\n');
    await writeFile(join(workspace, 'new.txt'), 'new file\n');
    const service = new GitService();

    await expect(service.status(workspace)).resolves.toEqual(expect.arrayContaining([
      { path: 'tracked.txt', status: 'modified' }, { path: 'new.txt', status: 'untracked' },
    ]));
    await expect(service.diff(workspace, 'new.txt')).resolves.toContain('+new file');
  });

  it('creates, checks out and lists branches', async () => {
    const workspace = await repository();
    const service = new GitService();
    await service.createBranch(workspace, 'feature/test', true);

    const created = await service.branches(workspace);
    expect(created.current).toBe('feature/test');
    expect(created.branches).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'feature/test', isCurrent: true })]));
    await service.checkout(workspace, 'master').catch(() => service.checkout(workspace, 'main'));
    await expect(service.branches(workspace)).resolves.toMatchObject({ branches: expect.arrayContaining([expect.objectContaining({ name: 'feature/test' })]) });
  });

  it('returns log graph entries and returns empty status outside a repository', async () => {
    const workspace = await repository();
    const nonRepository = await mkdtemp(join(tmpdir(), 'electron-agent-not-git-'));
    directories.push(nonRepository);
    const service = new GitService();

    await expect(service.logGraph(workspace, 1)).resolves.toMatchObject([{ subject: 'initial', parents: [] }]);
    await expect(service.status(nonRepository)).resolves.toEqual([]);
    await expect(service.branches(nonRepository)).resolves.toEqual({ current: '', branches: [] });
  });
});
