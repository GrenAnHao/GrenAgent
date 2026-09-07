import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Exercise the SDK on the application's Node runtime, not an arbitrary global Node.
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const filters = process.argv.slice(2);
const child = spawn(require('electron'), [
  '--liftoff-only', fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)), 'run',
  ...(filters.length ? filters : ['electron/app/codeGraph']),
], { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
child.on('error', (error) => { console.error(error); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
process.on('SIGINT', () => child.kill());
process.on('SIGTERM', () => child.kill());
