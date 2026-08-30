import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PiProcessCommand } from './pi/manager';

export interface RuntimePathsOptions {
  appPath: string;
  resourcesPath: string;
  isPackaged: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}

export function resolvePiProcess(options: RuntimePathsOptions): PiProcessCommand {
  const env = options.env ?? process.env;
  const configured = env.GREN_PI_COMMAND?.trim();
  if (configured) return { command: configured, args: ['--mode', 'rpc'] };

  const platform = options.platform ?? process.platform;
  const executable = platform === 'win32' ? 'pi.exe' : 'pi';
  const exists = options.exists ?? existsSync;
  const bundled = join(options.resourcesPath, 'pi', executable);
  if (options.isPackaged || exists(bundled)) return { command: bundled, args: ['--mode', 'rpc'] };

  const cliEntry = resolve(options.appPath, '..', 'cli', 'src', 'main.ts');
  return { command: resolveBunCommand(env, exists, platform), args: [cliEntry, '--mode', 'rpc'] };
}

function resolveBunCommand(env: NodeJS.ProcessEnv, exists: (path: string) => boolean, platform: NodeJS.Platform): string {
  const configured = env.GREN_BUN_COMMAND?.trim();
  if (configured) return configured;
  if (platform === 'win32') {
    const home = env.BUN_INSTALL?.trim() || env.USERPROFILE?.trim();
    if (home) {
      const executable = env.BUN_INSTALL?.trim()
        ? join(home, 'bin', 'bun.exe')
        : join(home, '.bun', 'bin', 'bun.exe');
      if (exists(executable)) return executable;
    }
  }
  return 'bun';
}

export function resolvePiPackageDir(options: RuntimePathsOptions): string {
  const bundled = join(options.resourcesPath, 'pi');
  if (options.isPackaged || existsSync(bundled)) return bundled;
  return resolve(options.appPath, '..', 'cli');
}
