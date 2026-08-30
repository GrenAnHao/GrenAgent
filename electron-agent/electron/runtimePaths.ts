import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PiProcessCommand } from './pi/manager';

export interface RuntimePathsOptions {
  appPath: string;
  resourcesPath: string;
  isPackaged: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export function resolvePiProcess(options: RuntimePathsOptions): PiProcessCommand {
  const configured = options.env?.GREN_PI_COMMAND?.trim();
  if (configured) return { command: configured, args: ['--mode', 'rpc'] };

  const executable = options.platform === 'win32' ? 'pi.exe' : 'pi';
  const bundled = join(options.resourcesPath, 'pi', executable);
  if (options.isPackaged || existsSync(bundled)) return { command: bundled, args: ['--mode', 'rpc'] };

  const cliEntry = resolve(options.appPath, '..', 'cli', 'src', 'main.ts');
  return { command: options.env?.GREN_BUN_COMMAND || 'bun', args: [cliEntry, '--mode', 'rpc'] };
}

export function resolvePiPackageDir(options: RuntimePathsOptions): string {
  const bundled = join(options.resourcesPath, 'pi');
  if (options.isPackaged || existsSync(bundled)) return bundled;
  return resolve(options.appPath, '..', 'cli');
}
