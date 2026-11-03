import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const results = [];
for (const project of ['cli', 'extensions', 'electron-agent']) {
  const packageRoot = resolve(project, 'node_modules/@earendil-works/pi-coding-agent');
  const shellPath = resolve(packageRoot, 'dist/utils/shell.js');
  const diffPath = resolve(packageRoot, 'dist/core/tools/edit-diff.js');
  const shell = readFileSync(shellPath, 'utf8');
  const diff = readFileSync(diffPath, 'utf8');
  const { generateDiffString } = await import(pathToFileURL(diffPath).href);
  const oldText = Array.from({ length: 21 }, (_, i) => `line-${i + 1}`).join('\n');
  const newText = oldText.replace('line-11\n', 'changed-11\n');
  results.push({ project, version: JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')).version,
    packageRoot: realpathSync(packageRoot), shellSha256: createHash('sha256').update(shell).digest('hex'),
    diffSha256: createHash('sha256').update(diff).digest('hex'),
    localShellHelper: shell.includes('function getWindowsSearchPath()'),
    spawnWhereCalls: shell.match(/spawnWhere\(/g)?.length ?? 0,
    defaultDiffContext: /generateDiffString\(oldContent, newContent, contextLines = (\d+)\)/.exec(diff)?.[1],
    diffOutput: generateDiffString(oldText, newText),
  });
}
mkdirSync('.tmp-pi-sdk-1.4', { recursive: true });
writeFileSync('.tmp-pi-sdk-1.4/patches-baseline-1.3.json', JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
