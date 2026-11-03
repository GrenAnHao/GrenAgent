import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { buildRepoWikiHost, REPO_WIKI_HOST_ENTRY } from '../electron/agent/repoWikiHostBuild.ts';
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
// Fixture Git writes must never inherit GIT_DIR/GIT_WORK_TREE from a developer shell.
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
async function run(args, env = environment) {
  const child = spawn(process.execPath, args, { cwd: app, env, stdio: 'inherit', windowsHide: true });
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
}
const typecheck = await run([join(dirname(require.resolve('typescript/package.json')), 'bin/tsc'), '-p', 'tsconfig.repo-wiki.json', '--noEmit']);
if (typecheck !== 0) {
  process.exitCode = typecheck;
} else {
  const base = resolve(tmpdir());
  const output = await mkdtemp(join(base, 'gren-repowiki-flow-'));
  try {
    await buildRepoWikiHost(app, output);
    process.exitCode = await run([join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs'), 'run', '--config', 'vitest.repo-wiki-flow.config.ts', ...process.argv.slice(2)], {
      ...environment, REPOWIKI_TEST_ENTRY: join(output, REPO_WIKI_HOST_ENTRY), REPOWIKI_TEST_EXECUTABLE: process.execPath,
    });
  } finally {
    if (dirname(resolve(output)) !== base || !basename(output).startsWith('gren-repowiki-flow-')) throw new Error('Unsafe temporary output');
    await rm(output, { recursive: true, force: true });
  }
}
