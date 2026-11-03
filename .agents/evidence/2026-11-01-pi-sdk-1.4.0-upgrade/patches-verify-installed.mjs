import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const expectedDiff = '    ...\n  6 line-6\n  7 line-7\n  8 line-8\n  9 line-9\n 10 line-10\n-11 line-11\n+11 changed-11\n 12 line-12\n 13 line-13\n 14 line-14\n 15 line-15\n 16 line-16\n    ...';
const results = [];
const cleanEnv = { PATH: '' };
for (const name of ['SystemRoot', 'WINDIR', 'ProgramFiles', 'ProgramFiles(x86)', 'TEMP', 'TMP']) {
  if (process.env[name]) cleanEnv[name] = process.env[name];
}
for (const project of ['cli', 'extensions', 'electron-agent']) {
  const root = resolve(project, 'node_modules/@earendil-works/pi-coding-agent');
  assert.equal(JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version, '1.4.0');
  const shellPath = resolve(root, 'dist/utils/shell.js');
  const diffPath = resolve(root, 'dist/core/tools/edit-diff.js');
  const { generateDiffString, generateUnifiedPatch } = await import(pathToFileURL(diffPath).href);
  const oldText = Array.from({ length: 21 }, (_, i) => `line-${i + 1}`).join('\n');
  const newText = oldText.replace('line-11\n', 'changed-11\n');
  assert.equal(generateDiffString(oldText, newText).diff, expectedDiff);
  assert.equal(generateDiffString(oldText, newText).firstChangedLine, 11);
  assert.match(generateUnifiedPatch('sample.txt', oldText, newText), /@@ -7,9 \+7,9 @@/);
  const childCode = `
    import assert from 'node:assert/strict';
    import { spawnSync } from 'node:child_process';
    import { getShellConfig, getPowerShellConfig } from ${JSON.stringify(pathToFileURL(shellPath).href)};
    assert.equal(process.env.PATH, '');
    const config = getShellConfig();
    const result = spawnSync(config.shell, [...config.args, "printf 'pi-sdk-1.4-patch-ok'"], {
      encoding: 'utf8', timeout: 10000, windowsHide: true, env: process.env,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'pi-sdk-1.4-patch-ok');
    console.log(JSON.stringify({ bash: config, powerShell: getPowerShellConfig(), sentinel: result.stdout }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
    cwd: resolve('.tmp-pi-sdk-1.4'), encoding: 'utf8', timeout: 30000, windowsHide: true, env: cleanEnv,
  });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  results.push({ project, version: '1.4.0', realRoot: realpathSync(root),
    shellSha256: createHash('sha256').update(readFileSync(shellPath)).digest('hex'),
    diffSha256: createHash('sha256').update(readFileSync(diffPath)).digest('hex'),
    shellInode: statSync(shellPath).ino,
    displayDiff: generateDiffString(oldText, newText), unifiedPatch: generateUnifiedPatch('sample.txt', oldText, newText),
    minimalPathExecution: JSON.parse(child.stdout),
  });
}
assert.equal(new Set(results.map((r) => r.shellSha256)).size, 1);
assert.equal(new Set(results.map((r) => r.diffSha256)).size, 1);
writeFileSync('.tmp-pi-sdk-1.4/patches-installed-1.4.json', JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
