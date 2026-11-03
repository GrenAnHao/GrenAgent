import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const broken = String.raw`process.env.SystemRoot || process.env.WINDIR || "C:\Windows"`;
const fixed = 'process.env.SystemRoot || process.env.WINDIR || "C:/Windows"';
for (const project of ['cli', 'extensions', 'electron-agent']) {
  const path = resolve(project, 'node_modules/@earendil-works/pi-coding-agent/dist/utils/shell.js');
  const source = readFileSync(path, 'utf8');
  const count = source.split(broken).length - 1;
  assert.ok(count === 0 || count === 2);
  if (count) writeFileSync(path, source.replaceAll(broken, fixed));
  assert.equal(readFileSync(path, 'utf8').split(fixed).length - 1, 2);
  console.log(project, count ? 'reapplied corrected fallback' : 'shared file already corrected');
}
