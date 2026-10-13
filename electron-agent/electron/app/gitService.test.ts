import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
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

// every case starts several real git processes for its fixture; with the whole suite running in parallel that can pass five seconds
describe('GitService', { timeout: 30_000 }, () => {
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

  it('pages log history across all branches, children before parents', async () => {
    const workspace = await repository();
    const service = new GitService();
    await service.createBranch(workspace, 'side', true);
    await writeFile(join(workspace, 'side.txt'), 'side\n');
    await execFile('git', ['add', 'side.txt'], { cwd: workspace });
    await execFile('git', ['commit', '-m', 'on side'], { cwd: workspace });
    await service.checkout(workspace, 'master').catch(() => service.checkout(workspace, 'main'));
    await writeFile(join(workspace, 'main.txt'), 'main\n');
    await execFile('git', ['add', 'main.txt'], { cwd: workspace });
    await execFile('git', ['commit', '-m', 'on main'], { cwd: workspace });

    const all = await service.logGraph(workspace, 10);
    expect(all.map((c) => c.subject).sort()).toEqual(['initial', 'on main', 'on side']);
    expect(all.at(-1)?.subject).toBe('initial');
    const first = await service.logGraph(workspace, 2);
    const rest = await service.logGraph(workspace, 2, 2);
    expect([...first, ...rest].map((c) => c.hash)).toEqual(all.map((c) => c.hash));
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
    await expect(service.logGraph(workspace, 1, 1)).resolves.toEqual([]);
    await expect(service.status(nonRepository)).resolves.toEqual([]);
    await expect(service.branches(nonRepository)).resolves.toEqual({ current: '', branches: [] });
  });

  // every script the fixtures run is a separate sh process, about a second each on Windows
  describe('in a workspace whose configuration a sandboxed command could have written', { timeout: 60_000 }, () => {
    const exists = (path: string) => stat(path).then(() => true, () => false);
    const posix = (path: string) => path.replaceAll('\\', '/');

    it('does not run the configured file system monitor when it reads the status (control: plain git does)', async () => {
      const workspace = await repository();
      const marker = join(workspace, 'fsmonitor-ran.txt');
      await writeFile(join(workspace, 'hook.sh'), `echo ran > "${posix(marker)}"\n`);
      await execFile('git', ['config', 'core.fsmonitor', `sh "${posix(join(workspace, 'hook.sh'))}"`], { cwd: workspace });
      await writeFile(join(workspace, 'tracked.txt'), 'changed\n');

      await expect(new GitService().status(workspace)).resolves.toEqual(expect.arrayContaining([{ path: 'tracked.txt', status: 'modified' }]));
      expect(await exists(marker)).toBe(false);
      await execFile('git', ['status', '--porcelain'], { cwd: workspace });
      expect(await exists(marker)).toBe(true);
    });

    it('does not run a clean filter or a text converter when it builds a diff (control: plain git does)', async () => {
      const workspace = await repository();
      const marker = join(workspace, 'ran.txt');
      // as a clean filter it reads standard input; as a text converter it is given the file name
      await writeFile(join(workspace, 'spy.sh'), `echo ran >> "${posix(marker)}"\nif [ -n "$1" ]; then cat "$1"; else cat; fi\n`);
      const spy = `sh "${posix(join(workspace, 'spy.sh'))}"`;
      await execFile('git', ['config', 'filter.spy.clean', spy], { cwd: workspace });
      await execFile('git', ['config', 'diff.spy.textconv', spy], { cwd: workspace });
      await writeFile(join(workspace, '.gitattributes'), 'tracked.txt filter=spy diff=spy\n');
      await writeFile(join(workspace, 'tracked.txt'), 'changed\n');

      await expect(new GitService().diff(workspace, 'tracked.txt')).resolves.toContain('+changed');
      expect(await exists(marker)).toBe(false);
      await execFile('git', ['diff'], { cwd: workspace });
      expect(await exists(marker)).toBe(true);
    });

    it('still runs the hooks of an action the user asked for, such as a checkout (they are the user\'s workflow)', async () => {
      const workspace = await repository();
      const marker = join(workspace, 'post-checkout-ran.txt');
      await writeFile(join(workspace, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\necho ran > "${posix(marker)}"\n`);
      await new GitService().createBranch(workspace, 'topic', true);
      expect(await exists(marker)).toBe(true);
    });
  });
});
