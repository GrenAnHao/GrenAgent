#!/usr/bin/env node
/**
 * Reproduce the catalogue failures end to end, without a real model provider.
 *
 *   1. parse the recorded real-model replies that used to abort generation
 *   2. build the real knowledge child and run the whole chain
 *      (generation -> publication -> task view -> page read) with a model that answers YAML
 *
 * Usage (from electron-agent/):
 *   node --import tsx scripts/verify-repo-wiki-catalogue.mjs
 *
 * Step 2 shells out to `npm run test:repo-wiki-flow`, which performs its own
 * typecheck + child build so the assertions run against fresh output.
 * Exit code 0 means every step published and served content.
 */
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { parseReferenceCatalogue } from '../electron/wikiService/referenceParsers.ts';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Fixture Git writes must never inherit GIT_DIR/GIT_WORK_TREE from a developer shell.
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
const fixtures = [
  ['fixtures/catalogue-yaml-fence.txt', 'YAML inside a ```yaml fence'],
  ['fixtures/catalogue-scalar-shapes.txt', 'JSON with scalar/list field shapes'],
];

function run(command, args) {
  const child = spawn(command, args, { cwd: app, env: environment, stdio: 'inherit', windowsHide: true, shell: false });
  return new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', code => resolveExit(code ?? 1)); });
}

let failed = false;
console.log('== 1. parsing the recorded real-model replies ==');
for (const [file, label] of fixtures) {
  const raw = readFileSync(join(app, 'electron/wikiService', file), 'utf8');
  const parsed = parseReferenceCatalogue(raw);
  if (!parsed.ok) { failed = true; console.log(`FAIL ${label}: ${parsed.error}`); continue; }
  console.log(`ok   ${label} -> ${parsed.value.items.length} sections: ${parsed.value.items.map(item => item.name).join(', ')}`);
}

console.log('\n== 2. generation -> publication -> read (catalogue answered as YAML) ==');
// Run the existing entry point rather than a shell; it does its own typecheck and child build.
const code = await run(process.execPath, ['--import', 'tsx', 'scripts/test-repo-wiki-flow.mjs', '-t', 'YAML']);
if (code !== 0) failed = true;

console.log(failed ? '\nRESULT: FAILED' : '\nRESULT: both catalogue shapes parse, and the YAML run publishes and serves its page.');
process.exitCode = failed ? 1 : 0;
