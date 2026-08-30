import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const appRoot = resolve(import.meta.dirname, '..');
const sidecarRoot = resolve(appRoot, '..', 'cli');
const resourceRoot = join(appRoot, 'resources', 'pi');
const executable = process.platform === 'win32' ? 'pi.exe' : 'pi';

if (!existsSync(join(sidecarRoot, 'package.json'))) {
  throw new Error(`Pi sidecar source is missing: ${sidecarRoot}`);
}

mkdirSync(resourceRoot, { recursive: true });
console.log('Installing Pi sidecar dependencies…');
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install'], { cwd: sidecarRoot, stdio: 'inherit' });
console.log('Compiling Pi sidecar…');
execFileSync('bun', ['build', './src/main.ts', '--compile', '--outfile', join(resourceRoot, executable)], {
  cwd: sidecarRoot,
  stdio: 'inherit',
});

const piDist = join(sidecarRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist');
if (existsSync(piDist)) {
  for (const directory of ['theme', 'assets', 'export-html', 'docs', 'examples']) {
    const source = join(piDist, directory);
    if (existsSync(source)) cpSync(source, join(resourceRoot, directory), { recursive: true, force: true });
  }
}
console.log(`Pi sidecar ready: ${join(resourceRoot, executable)}`);
