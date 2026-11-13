import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { promisify } from 'node:util';
import { vi } from 'vitest';
import { DefaultPackageManager, SettingsManager } from '../../../../cli/src/pi-sdk.js';

function tar(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const bytes = Buffer.from(content), header = Buffer.alloc(512);
    header.write(`package/${name}`, 0, 100); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136); header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257); header.write('00', 263);
    header.write(header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

/** Only loopback tarballs, local git, temporary settings and harmless counting scripts. */
export async function packageUpdateFixture() {
  const root = await mkdtemp(join(tmpdir(), 'gren-package-update-'));
  const cwd = join(root, 'project'), agentDir = join(root, 'agent'), counter = join(root, 'script-count.txt');
  await mkdir(cwd); await mkdir(agentDir);
  const empty = join(root, 'empty-config'), globalNpm = join(root,'global.npmrc'); await writeFile(empty, ''); await writeFile(globalNpm,'');
  for (const key of Object.keys(process.env)) if (/^(?:npm_|yarn_|node_auth_token$|http_proxy$|https_proxy$|all_proxy$|git_askpass$)/i.test(key)) vi.stubEnv(key, undefined);
  vi.stubEnv('PI_OFFLINE', ''); vi.stubEnv('GREN_PACKAGE_TEST_COUNTER', counter);
  const npmCli = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  if (!existsSync(npmCli)) throw new Error('Fixture needs the local Node npm CLI');
  const requests: string[] = [];
  let registry = '';
  let published = '1.0.0';
  const packages: Record<string, Record<string, { manifest: Record<string, unknown>; tarball: Buffer }>> = {};
  for (const name of ['gren-demo-a', 'gren-demo-b', 'gren-shared']) {
    packages[name] = {};
    for (const version of ['1.0.0', '2.0.0', '3.0.0']) {
      const manifest = {
        name, version,
        ...(name === 'gren-demo-a' ? { dependencies: { 'gren-shared': version === '1.0.0' ? '1.0.0' : '2.0.0' }, scripts: { postinstall: 'node postinstall.cjs' }, pi: { extensions: ['./extension.cjs'] } } : {}),
        ...(name === 'gren-demo-b' ? { dependencies: { 'gren-shared': '*' }, pi: { extensions: ['./extension.cjs'] } } : {}),
      };
      packages[name][version] = { manifest, tarball: tar({
        'package.json': JSON.stringify(manifest),
        'index.js': `module.exports = ${JSON.stringify(version)};`,
        'extension.cjs': `module.exports = pi => { globalThis.__packageFixtureLoads ??= []; globalThis.__packageFixtureLoads.push({name:${JSON.stringify(name)},version:${JSON.stringify(version)}}); pi.registerCommand(${JSON.stringify(name)}, { description:'fixture', handler:async (_args,ctx)=>ctx.ui.notify(${JSON.stringify(version)},'info') }); };`,
        'CHANGELOG.md': `# ${version}\nFixture-only notes for ${name}.`,
        'postinstall.cjs': version === '3.0.0' ? 'process.exit(7)' : "require('node:fs').appendFileSync(process.env.GREN_PACKAGE_TEST_COUNTER, process.cwd()+'\\n');",
      }) };
    }
  }
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    const path = decodeURIComponent((request.url ?? '').split('?')[0]);
    const archive = /^\/([^/]+)\/-\/[^/]+-(\d+\.\d+\.\d+)\.tgz$/.exec(path);
    if (archive) {
      const item = packages[archive[1]]?.[archive[2]];
      if (!item) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'content-type': 'application/octet-stream' }); response.end(item.tarball); return;
    }
    const name = path.slice(1), versions = packages[name];
    if (!versions) { response.writeHead(404); response.end('{}'); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ name, 'dist-tags': { latest: published }, versions: Object.fromEntries(Object.entries(versions).filter(([version])=>Number(version[0])<=Number(published[0])).map(([version, item]) => [version, { ...item.manifest, dist: { tarball: `${registry}/${name}/-/${name}-${version}.tgz` } }])) }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port'); registry = `http://127.0.0.1:${address.port}`;
  const npmCommand = [process.execPath, npmCli, '--registry', registry, '--cache', join(root, 'cache'), '--userconfig', empty, '--globalconfig', globalNpm, '--no-audit', '--no-fund'];
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ npmCommand, cacheWarming: 'off' }));
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
  const install = async (source: string, local = false) => { await manager.installAndPersist(source, { local }); await settings.flush(); const errors = settings.drainErrors(); if (errors.length) throw errors[0].error; };
  const version = async (name: string, scope: 'user' | 'project' = 'user') => JSON.parse(await readFile(join(manager.getInstalledPath(`npm:${name}`, scope)!, 'package.json'), 'utf8')).version as string;
  const scripts = async () => { try { return (await readFile(counter, 'utf8')).trim().split('\n').filter(Boolean).length; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; } };
  const execute = promisify(execFile);
  const git = async (args: string[], at = cwd) => (await execute('git', args, { cwd: at, windowsHide: true, timeout: 10000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
  const localGitRemote = async () => {
    const repo = join(root, 'remote'); await mkdir(repo); await git(['init', '-b', 'main'], repo); await git(['config', 'user.name', 'Fixture'], repo); await git(['config', 'user.email', 'fixture@example.invalid'], repo);
    await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'git-fixture', version: '1.0.0' })); await writeFile(join(repo, '.gitignore'), 'node_modules/\npackage-lock.json\n');
    await git(['add', '.'], repo); await git(['commit', '-m', 'first'], repo); const first = await git(['rev-parse', 'HEAD'], repo);
    await writeFile(join(repo, 'CHANGELOG.md'), '# Same version, new commit'); await git(['add', '.'], repo); await git(['commit', '-m', 'second'], repo); const second = await git(['rev-parse', 'HEAD'], repo);
    const remote = 'https://fixture.invalid/team/demo';
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1'); vi.stubEnv('GIT_CONFIG_GLOBAL', empty); vi.stubEnv('GIT_CONFIG_COUNT', '2');
    vi.stubEnv('GIT_CONFIG_KEY_0', `url.file:///${repo.replace(/\\/g, '/')}.insteadOf`); vi.stubEnv('GIT_CONFIG_VALUE_0', remote); vi.stubEnv('GIT_CONFIG_KEY_1', 'protocol.file.allow'); vi.stubEnv('GIT_CONFIG_VALUE_1', 'always');
    return { repo, remote, first, second };
  };
  return { root, cwd, agentDir, counter, registry, npmCommand, settings, manager, requests, install, version, scripts, git, localGitRemote, publish:(version='2.0.0')=>{published=version;},
    async cleanup() { await settings.flush(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe fixture root'); await rm(root, { recursive: true, force: true }); },
  };
}
