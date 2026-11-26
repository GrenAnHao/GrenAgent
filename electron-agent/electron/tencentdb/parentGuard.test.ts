import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { parentGuardImport } from './parentGuard';

it('keeps the child alive until its parent closes stdin', async () => {
  const child = spawn(process.execPath, ['--import', parentGuardImport(), '-e', "process.stdout.write('ready'); setTimeout(() => process.exit(42), 2500)"], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const exit = once(child, 'exit');
  try {
    await Promise.race([
      once(child.stdout, 'data'),
      exit.then(([code]) => { throw new Error('watchdog exited before stdin closed: ' + code); }),
    ]);
    expect(child.exitCode).toBeNull();
    child.stdin.end();
    expect(await exit).toEqual([0, null]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});
