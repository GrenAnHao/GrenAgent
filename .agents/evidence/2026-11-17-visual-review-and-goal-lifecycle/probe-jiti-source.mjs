import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = resolve('electron-agent/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js');
const { loadExtensions } = await import(pathToFileURL(dist).href);
const dir = mkdtempSync(join(tmpdir(), 'visual-review-jiti-'));
try {
  writeFileSync(join(dir, 'index.ts'), 'import { marker } from "./source.js"; export default function(pi) { pi.registerFlag("loaded-from", { type: "string", default: marker }); }\n');
  writeFileSync(join(dir, 'source.ts'), 'export const marker = "typescript-source";\n');
  writeFileSync(join(dir, 'source.js'), 'export const marker = "stale-javascript";\n');
  const result = await loadExtensions([join(dir, 'index.ts')], dir);
  console.log(JSON.stringify({ errors: result.errors, source: result.runtime.flagValues.get('loaded-from'), extensions: result.extensions.length }));
  if (result.errors.length || result.extensions.length !== 1) process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
