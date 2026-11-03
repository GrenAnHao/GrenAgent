import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('electron-agent/out-pkg/main');
const chunks = resolve(root, 'chunks');
const candidates = readdirSync(chunks).filter((name) => name.endsWith('.jsc')).map((name) => {
  const path = resolve(chunks, name);
  const bytes = readFileSync(path);
  return { path, bytes };
}).filter(({ bytes }) => bytes.includes(Buffer.from('getWindowsSearchPath')) && bytes.includes(Buffer.from('findGitBashFromGitCmd')));
assert.equal(candidates.length, 1, 'one production SDK implementation owns the patched shell resolver');
const [{ path, bytes }] = candidates;
assert.ok(bytes.includes(Buffer.from('where.exe')));
assert.ok(bytes.includes(Buffer.from('C:/Windows')), 'corrected missing-environment fallback is in production bytecode');
assert.ok(!bytes.includes(Buffer.from('C:Windows')), 'broken escaped fallback is absent');
const required = ['main.js', 'main.jsc', 'agent-host.js', 'agent-host.jsc', 'pi-worker.js', 'pi-worker.jsc', 'bytecode-loader.cjs', 'package.json',
  'runner.py', 'runner.mjs', 'pi-job-guard.exe', 'pi-sandbox-win.exe', 'pi-sandbox-launch.exe', 'prompts', 'texts', 'ultra-rules.md',
  'chunks/runner.py', 'chunks/runner.mjs', 'chunks/pi-sandbox-win.exe', 'chunks/pi-sandbox-launch.exe', 'chunks/prompts', 'chunks/texts', 'chunks/ultra-rules.md'];
for (const relative of required) assert.ok(existsSync(resolve(root, relative)), relative);
assert.equal(JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).type, 'commonjs');
const result = { shellBytecode: path, sha256: createHash('sha256').update(bytes).digest('hex'),
  buildTime: statSync(path).mtime.toISOString(), correctedFallbackPresent: true, requiredResources: required,
  scope: 'Production resource/path inspection; shell execution is independently verified on the actual installed SDKs. No production app was started.' };
writeFileSync('.tmp-pi-sdk-1.4/patches-production-resources.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
