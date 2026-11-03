import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRepoWikiHost } from './repoWikiHostBuild';

const appDir = resolve(import.meta.dirname, '../..');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('RepoWiki host build', () => {
  it.each(['out/main', 'out-pkg/main'])('builds a standalone CJS child in %s that starts without node_modules', async (layout) => {
    const root = await mkdtemp(join(tmpdir(), 'gren-repowiki-build-'));
    temporaryDirectories.push(root);
    // The production bundle must also work below an unrelated ESM application.
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    const outDir = join(root, layout);
    const result = await buildRepoWikiHost(appDir, outDir);
    expect(await readdir(outDir)).toEqual(['repo-wiki-host.cjs']);
    expect(Object.keys(result.metafile!.outputs)).toHaveLength(1);
    const imports = Object.values(result.metafile!.outputs).flatMap((output) => output.imports);
    expect(imports.every((entry) => entry.external && entry.path.startsWith('node:'))).toBe(true);

    const child = fork(join(outDir, 'repo-wiki-host.cjs'), [], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        REPOWIKI_DATA_DIR: join(root, 'data'),
        REPOWIKI_ALLOWED_ROOTS: '[]',
        REPOWIKI_PROVIDER_BRIDGE: '1',
        REPOWIKI_HOST_MODEL_KEY: 'build-test-no-model-calls',
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr!.on('data', (chunk) => { stderr += chunk.toString(); });
    const nextMessage = () => Promise.race([
      once(child, 'message').then(([message]) => message),
      once(child, 'exit').then(([code]) => { throw new Error(`RepoWiki exited ${code}: ${stderr}`); }),
    ]);
    try {
      expect(await nextMessage()).toMatchObject({ v: 1, type: 'ready', pid: child.pid });
      expect(child.pid).not.toBe(process.pid);
      const response = nextMessage();
      child.send({ v: 1, type: 'request', id: 'stop', action: 'shutdown', input: {} });
      expect(await response).toMatchObject({ v: 1, type: 'response', id: 'stop', ok: true, result: { stopped: true } });
      expect(await once(child, 'exit')).toEqual([0, null]);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  }, 20_000);
});
