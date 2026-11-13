import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { checkPackageUpdate, parseManagedSource, readPackageChangelog, readPackageSnapshot } from './piPackageMetadata';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('unsafe fixture cleanup'); await rm(root, { recursive: true, force: true }); } });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gren-package-meta-')); roots.push(root);
  const installedPath = join(root, 'npm/node_modules/demo');
  await mkdir(installedPath, { recursive: true });
  await writeFile(join(installedPath, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
  return { root, installedPath };
}
it('uses stable source identity without changing the legacy source helpers', () => {
  expect(parseManagedSource('npm:@scope/demo@1.0.0')).toMatchObject({ kind: 'npm', name: '@scope/demo', ref: '1.0.0', identity: 'npm:@scope/demo' });
  expect(parseManagedSource('git:github.com/acme/demo@v1')).toMatchObject({ kind: 'git', repo: 'https://github.com/acme/demo', ref: 'v1', identity: 'git:github.com/acme/demo' });
  expect(parseManagedSource('git:https://github.com/acme/demo.git@v2')).toMatchObject({ kind: 'git', identity: 'git:github.com/acme/demo' });
  expect(parseManagedSource('./local')).toMatchObject({ kind: 'local' });
  expect(parseManagedSource('git:https://user:secret@github.com/acme/demo')).toMatchObject({ kind: 'unsupported' });
  expect(parseManagedSource('git:https://github.com/acme/../demo')).toMatchObject({ kind: 'unsupported' });
});
it('reads scoped disk version and disabled filters without resolving or installing resources', async () => {
  const f = await fixture(); const entry = { source: 'npm:demo@1.0.0', autoload: false, skills: ['kept'] };
  const snapshot = await readPackageSnapshot({ scope: 'user', entry, installedPath: f.installedPath, managedRoot: join(f.root, 'npm') });
  expect(snapshot).toMatchObject({ scope: 'user', enabled: false, installedVersion: '1.0.0', configuredTarget: '1.0.0', installState: 'installed', identity: 'npm:demo', filters: { skills: ['kept'] } });
  const project = await readPackageSnapshot({ scope: 'project', workspace: f.root, entry, installedPath: f.installedPath, managedRoot: join(f.root, 'npm') });
  expect(project.key).not.toBe(snapshot.key);
  const missing = await readPackageSnapshot({ scope: 'user', entry, managedRoot: join(f.root, 'npm') });
  expect(missing.installState).toBe('missing');
});
it('checks exact npm pins read-only and separates offline/errors from no update', async () => {
  const f = await fixture();
  const snapshot = await readPackageSnapshot({ scope: 'user', entry: 'npm:demo@1.0.0', installedPath: f.installedPath, managedRoot: join(f.root, 'npm') });
  const before = await readFile(join(f.installedPath, 'package.json'), 'utf8');
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ versions: { '1.0.0': {}, '1.1.0': {}, '2.0.0-beta.1': {} } })));
  expect(await checkPackageUpdate(snapshot, { fetch: fetcher as typeof fetch, registry: 'https://registry.example' })).toMatchObject({ state: 'available', targetVersion: '1.1.0', targetSource: 'npm:demo@1.1.0' });
  expect(await readFile(join(f.installedPath, 'package.json'), 'utf8')).toBe(before);
  expect(await checkPackageUpdate(snapshot, { offline: true, fetch: fetcher as typeof fetch })).toMatchObject({ state: 'offline' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await checkPackageUpdate(snapshot, { fetch: (async () => new Response('failed', { status: 503 })) as typeof fetch })).toMatchObject({ state: 'error' });
});
it('checks git refs with an injected read-only git transport and fixed commit target', async () => {
  const f = await fixture();
  const snapshot = await readPackageSnapshot({ scope: 'user', entry: 'git:github.com/acme/demo@main', installedPath: f.installedPath, managedRoot: f.root, git: async () => 'a'.repeat(40) });
  const git = vi.fn(async (_args: string[]) => `${'b'.repeat(40)}\trefs/heads/main\n`);
  const result = await checkPackageUpdate(snapshot, { git });
  expect(result).toMatchObject({ state: 'available', targetCommit: 'b'.repeat(40), targetSource: `git:https://github.com/acme/demo@${'b'.repeat(40)}` });
  expect(git.mock.calls[0][0]).toContain('ls-remote');
  expect(git.mock.calls[0][0]).not.toContain('fetch');
});
it('reads only static in-root changelog metadata and respects explicit opt-out', async () => {
  const f = await fixture();
  await writeFile(join(f.installedPath, 'CHANGELOG.md'), '# Changes\n<script>alert(1)</script>\n![remote](https://secret.invalid/image)');
  expect(await readPackageChangelog(f.installedPath)).toMatchObject({ state: 'available', text: expect.stringContaining('<script>') });
  await writeFile(join(f.installedPath, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', pi: { changelogPath: '../outside.md' } }));
  expect(await readPackageChangelog(f.installedPath)).toMatchObject({ state: 'unavailable' });
  await writeFile(join(f.installedPath, 'package.json'), JSON.stringify({ pi: { changelogPath: '' } }));
  expect(await readPackageChangelog(f.installedPath)).toMatchObject({ state: 'disabled' });
});
it('git resource repositories do not require package.json to have a valid installed commit', async () => {
  const f = await fixture(); await rm(join(f.installedPath, 'package.json'));
  const row = await readPackageSnapshot({ scope: 'user', entry: 'git:github.com/acme/demo@main', installedPath: f.installedPath, managedRoot: f.root, git: async () => 'a'.repeat(40) });
  expect(row).toMatchObject({ installState: 'installed', installedCommit: 'a'.repeat(40) });
  expect(row.installedVersion).toBeUndefined();
});
it('uses configured npm metadata and compares explicit prerelease identifiers in order', async () => {
  const f = await fixture();
  await writeFile(join(f.installedPath, 'package.json'), JSON.stringify({ version: '2.0.0-beta.2' }));
  const snapshot = await readPackageSnapshot({ scope: 'user', entry: 'npm:demo@2.0.0-beta.2', installedPath: f.installedPath, managedRoot: join(f.root, 'npm') });
  const npmVersions = async () => ['1.1.0', '2.0.0-beta.2', '2.0.0-beta.10'];
  expect(await checkPackageUpdate(snapshot, { npmVersions, targetRef: '2.0.0-beta.10' })).toMatchObject({ state: 'available', targetVersion: '2.0.0-beta.10' });
  expect(await checkPackageUpdate(snapshot, { npmVersions })).toMatchObject({ state: 'up-to-date', targetVersion: '1.1.0' });
  expect(await checkPackageUpdate(snapshot, { npmVersions, targetRef: '2.0.0-beta.1' })).toMatchObject({ state: 'error' });
});
it('reads default changelog in a manifest-free resource repository and rejects an outside link', async () => {
  const f = await fixture();
  await rm(join(f.installedPath, 'package.json'));
  await writeFile(join(f.installedPath, 'CHANGELOG.md'), '# Resource updates');
  expect(await readPackageChangelog(f.installedPath)).toMatchObject({ state: 'available', text: '# Resource updates' });
  const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'changes.md'), 'private');
  await symlink(outside, join(f.installedPath, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(f.installedPath, 'package.json'), JSON.stringify({ pi: { changelogPath: 'outside/changes.md' } }));
  expect(await readPackageChangelog(f.installedPath)).toMatchObject({ state: 'unavailable', reason:'outside-root' });
});

it('reports static notes format/size/path failures without executing any content',async()=>{
 const f=await fixture();await writeFile(join(f.installedPath,'changes.js'),'globalThis.packageCodeExecuted=true');await writeFile(join(f.installedPath,'package.json'),JSON.stringify({pi:{changelogPath:'changes.js'}}));
 expect(await readPackageChangelog(f.installedPath)).toMatchObject({state:'unavailable',reason:'unsupported-format'});
 await writeFile(join(f.installedPath,'package.json'),JSON.stringify({pi:{changelogPath:'notes.txt'}}));await writeFile(join(f.installedPath,'notes.txt'),'x'.repeat(256*1024+1));expect(await readPackageChangelog(f.installedPath)).toMatchObject({state:'unavailable',reason:'too-large'});
 await writeFile(join(f.installedPath,'notes.txt'),'plain <script>not executed</script>');expect(await readPackageChangelog(f.installedPath)).toMatchObject({state:'available',format:'text'});
 expect((globalThis as any).packageCodeExecuted).toBeUndefined();
});
