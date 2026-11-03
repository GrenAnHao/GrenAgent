// Exercise vendored contracts/core/service with the host-built Electron child.
// Fixtures and model completions are local and deterministic; no paid calls.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { buildRepoWikiHost, REPO_WIKI_HOST_ENTRY } from '../electron/agent/repoWikiHostBuild.ts';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const output = await mkdtemp(join(tmpdir(), 'gren-repowiki-test-'));
let exitCode = 1;
try {
  await buildRepoWikiHost(appDir, output);
  const tests = [];
  const packages = join(appDir, 'vendor/repo-wiki/packages');
  for (const name of (await readdir(packages)).sort()) {
    const dir = join(packages, name, 'tests');
    let files;
    try { files = await readdir(dir); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const file of files.sort()) if (file.endsWith('.test.ts')) tests.push(join(dir, file));
  }
  if (!tests.length) throw new Error('No Repo Wiki tests were found');
  const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=2', ...tests], {
    cwd: appDir,
    env: {
      ...process.env,
      REPOWIKI_TEST_ENTRY: join(output, REPO_WIKI_HOST_ENTRY),
      REPOWIKI_TEST_EXECUTABLE: require('electron'),
    },
    stdio: 'inherit',
    windowsHide: true,
  });
  exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
} finally {
  await rm(output, { recursive: true, force: true });
}
process.exitCode = exitCode;
