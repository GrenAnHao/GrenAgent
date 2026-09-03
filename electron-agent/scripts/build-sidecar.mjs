import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const isWindows = process.platform === 'win32';
const appRoot = resolve(import.meta.dirname, '..');
const sidecarRoot = resolve(appRoot, '..', 'cli');
const resourceRoot = join(appRoot, 'resources', 'pi');
const executable = isWindows ? 'pi.exe' : 'pi';

// Windows 上 npm / bun 都是 .cmd 包装，execFileSync 必须经 shell 才能启动；
// shell 模式下 Node 不转义参数，含空格的路径（如 …\Project Files\…）需自行加引号。
function run(command, args) {
  const finalArgs = isWindows ? args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)) : args;
  execFileSync(isWindows ? `${command}.cmd` : command, finalArgs, {
    cwd: sidecarRoot,
    stdio: 'inherit',
    shell: isWindows,
  });
}

if (!existsSync(join(sidecarRoot, 'package.json'))) {
  throw new Error(`Pi sidecar source is missing: ${sidecarRoot}`);
}

mkdirSync(resourceRoot, { recursive: true });
console.log('Installing Pi sidecar dependencies…');
run('npm', ['install']);
console.log('Compiling Pi sidecar…');
run('bun', ['build', './src/main.ts', '--compile', '--outfile', join(resourceRoot, executable)]);

const piDist = join(sidecarRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist');
if (existsSync(piDist)) {
  for (const directory of ['theme', 'assets', 'export-html', 'docs', 'examples']) {
    const source = join(piDist, directory);
    if (existsSync(source)) cpSync(source, join(resourceRoot, directory), { recursive: true, force: true });
  }
}
console.log(`Pi sidecar ready: ${join(resourceRoot, executable)}`);
