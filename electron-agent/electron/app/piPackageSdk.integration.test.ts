import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { DefaultPackageManager, SettingsManager } from '../../../cli/src/pi-sdk.js';

const cleanups: Array<() => Promise<unknown>> = [];
const execute = promisify(execFile);
afterEach(async () => { vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function archive(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const bytes = Buffer.from(content); const header = Buffer.alloc(512);
    header.write(`package/${name}`, 0, 100); header.write('0000644\0', 100);
    header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136); header.fill(32, 148, 156); header[156] = 48;
    header.write('ustar\0', 257); header.write('00', 263);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gren-package-sdk-'));
  cleanups.push(async () => { if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('unsafe fixture cleanup'); await rm(root, { recursive: true, force: true }); });
  const agentDir = join(root, 'agent'); const cwd = join(root, 'project');
  await mkdir(agentDir); await mkdir(cwd);
  const emptyConfig = join(root, 'empty.npmrc'); await writeFile(emptyConfig, '');
  const npmCli = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  if (!existsSync(npmCli)) throw new Error('fixture requires npm bundled with the test Node runtime');
  const hits: string[] = [];
  const tarballs = Object.fromEntries(['1.0.0', '2.0.0'].map((version) => [version, archive({
    'package.json': JSON.stringify({ name: 'gren-fixture-package', version }), 'index.js': `module.exports = ${JSON.stringify(version)};`,
  })]));
  let registry = '';
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    if (req.url?.endsWith('.tgz')) {
      const version = req.url.includes('2.0.0') ? '2.0.0' : '1.0.0';
      res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(tarballs[version]); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: 'gren-fixture-package', 'dist-tags': { latest: '2.0.0' }, versions: Object.fromEntries(['1.0.0', '2.0.0'].map((version) => [version, {
      name: 'gren-fixture-package', version, dist: { tarball: `${registry}/gren-fixture-package/-/gren-fixture-package-${version}.tgz` },
    }])) }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('no fixture port');
  registry = `http://127.0.0.1:${address.port}`;
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'PI_OFFLINE']) vi.stubEnv(key, '');
  const settings = SettingsManager.inMemory({ npmCommand: [process.execPath, npmCli, '--registry', registry, '--cache', join(root, 'cache'), '--userconfig', emptyConfig, '--globalconfig', emptyConfig] }, { projectTrusted: true });
  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
  const version = async (scope: 'user' | 'project') => JSON.parse(await readFile(join(manager.getInstalledPath('npm:gren-fixture-package', scope)!, 'package.json'), 'utf8')).version;
  return { root, cwd, agentDir, settings, manager, version, hits };
}

it('real SDK pinned update/check do not silently move the exact version', async () => {
  const f = await fixture();
  await f.manager.installAndPersist('npm:gren-fixture-package@1.0.0');
  expect(await f.version('user')).toBe('1.0.0');
  const before = f.hits.length;
  await f.manager.update('npm:gren-fixture-package@1.0.0');
  expect(await f.manager.checkForAvailableUpdates()).toEqual([]);
  expect(f.hits.length).toBe(before);
  expect(await f.version('user')).toBe('1.0.0');
  expect(f.settings.getGlobalSettings().packages).toEqual(['npm:gren-fixture-package@1.0.0']);
}, 30000);

it('real SDK explicit installation replaces pin while preserving object filters and autoload', async () => {
  const f = await fixture();
  f.settings.setPackages([{ source: 'npm:gren-fixture-package@1.0.0', autoload: false, skills: ['kept'], extensions: [] }]);
  await f.manager.installAndPersist('npm:gren-fixture-package@2.0.0');
  expect(await f.version('user')).toBe('2.0.0');
  expect(f.settings.getGlobalSettings().packages).toEqual([{ source: 'npm:gren-fixture-package@2.0.0', autoload: false, skills: ['kept'], extensions: [] }]);
}, 30000);

it('real SDK update(source) can affect both scopes for an unpinned identity', async () => {
  const f = await fixture();
  f.settings.setPackages(['npm:gren-fixture-package']);
  f.settings.setProjectPackages(['npm:gren-fixture-package']);
  await f.manager.install('npm:gren-fixture-package@1.0.0');
  await f.manager.install('npm:gren-fixture-package@1.0.0', { local: true });
  await f.manager.update('npm:gren-fixture-package');
  expect(await f.version('user')).toBe('2.0.0');
  expect(await f.version('project')).toBe('2.0.0');
}, 60000);

it('real SDK git install can reset the checkout before a dependency failure, without rolling back', async () => {
  const f = await fixture(); const repo = join(f.root, 'remote'); await mkdir(repo);
  const git = async (...args: string[]) => (await execute('git', args, { cwd: repo, windowsHide: true, timeout: 10000 })).stdout.trim();
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'git-fixture', version: '1.0.0' }));
  await git('add', 'package.json'); await git('commit', '-m', 'v1'); const first = await git('rev-parse', 'HEAD');
  const remoteUrl = 'https://fixture.invalid/team/demo';
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1'); vi.stubEnv('GIT_CONFIG_GLOBAL', join(f.root, 'empty.npmrc'));
  vi.stubEnv('GIT_CONFIG_COUNT', '2');
  vi.stubEnv('GIT_CONFIG_KEY_0', `url.file:///${repo.replace(/\\/g, '/')}.insteadOf`);
  vi.stubEnv('GIT_CONFIG_VALUE_0', remoteUrl);
  vi.stubEnv('GIT_CONFIG_KEY_1', 'protocol.file.allow'); vi.stubEnv('GIT_CONFIG_VALUE_1', 'always');
  const oldSource = `git:${remoteUrl}@${first}`;
  await f.manager.installAndPersist(oldSource);
  const installed = f.manager.getInstalledPath(oldSource, 'user')!;
  expect((await execute('git', ['rev-parse', 'HEAD'], { cwd: installed, windowsHide: true })).stdout.trim()).toBe(first);
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'git-fixture', version: '2.0.0' }));
  await git('add', 'package.json'); await git('commit', '-m', 'v2'); const second = await git('rev-parse', 'HEAD');
  const fail = join(f.root, 'fail-install.cjs'); await writeFile(fail, 'process.exit(7)');
  f.settings.setNpmCommand([process.execPath, fail]);
  await expect(f.manager.installAndPersist(`git:${remoteUrl}@${second}`)).rejects.toThrow();
  expect((await execute('git', ['rev-parse', 'HEAD'], { cwd: installed, windowsHide: true })).stdout.trim()).toBe(second);
  expect(f.settings.getGlobalSettings().packages).toEqual([oldSource]);
}, 60000);
