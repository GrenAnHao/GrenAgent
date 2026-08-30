import { describe, expect, it } from 'vitest';
import { resolvePiPackageDir, resolvePiProcess } from './runtimePaths';

describe('runtime paths', () => {
  it('uses an explicit command when configured', () => {
    expect(resolvePiProcess({
      appPath: 'C:/app/electron-agent',
      resourcesPath: 'C:/app/resources',
      isPackaged: false,
      env: { GREN_PI_COMMAND: 'custom-pi' },
    })).toEqual({ command: 'custom-pi', args: ['--mode', 'rpc'] });
  });

  it('resolves development cli and packaged resource roots', () => {
    const process = resolvePiProcess({
      appPath: 'C:/app/electron-agent',
      resourcesPath: 'C:/app/resources',
      isPackaged: false,
      platform: 'win32',
      env: { GREN_BUN_COMMAND: 'bun.exe' },
    });
    expect(process.command).toBe('bun.exe');
    expect(process.args[0].replaceAll('\\', '/')).toBe('C:/app/cli/src/main.ts');
    const packageDir = resolvePiPackageDir({
      appPath: 'C:/app/electron-agent',
      resourcesPath: 'C:/app/resources',
      isPackaged: true,
    });
    expect(packageDir.replaceAll('\\', '/')).toBe('C:/app/resources/pi');
  });
});
