import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PermissionProfileName } from '../permissionManager';

export type SandboxNetwork = 'none' | 'allowlist' | 'full';

export interface SandboxCapabilities {
  osIsolation: boolean;
  networkIsolation: boolean;
  pathBoundary: boolean;
}

export interface SandboxManagerOptions {
  capabilities?: Partial<SandboxCapabilities>;
  now?: () => number;
}

export interface SandboxRunRequest {
  profile?: PermissionProfileName;
  workspaceRoot?: string;
  cwd?: string;
  readPaths?: string[];
  writePaths?: string[];
  network?: SandboxNetwork;
  needsNetwork?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface SandboxLaunchOptions {
  profile: PermissionProfileName;
  cwd?: string;
  env: NodeJS.ProcessEnv;
  network: SandboxNetwork;
  degraded: boolean;
}

type LaunchFn<T> = (options: SandboxLaunchOptions) => T;

const defaultCapabilities: SandboxCapabilities = {
  osIsolation: false,
  networkIsolation: false,
  pathBoundary: true,
};

/**
 * bash / user_bash 由 extensions/sandbox confine。
 * 本类只给 PTY 与子代理做路径 / env 过滤。
 * `degraded` 不是降级裸跑开关。
 */
export class SandboxManager {
  private readonly capabilities: SandboxCapabilities;
  private readonly now: () => number;

  constructor(private readonly options: SandboxManagerOptions = {}) {
    this.capabilities = { ...defaultCapabilities, ...options.capabilities };
    this.now = options.now ?? Date.now;
  }

  run<T>(request: SandboxRunRequest, launch: LaunchFn<T>): T {
    const prepared = this.prepare(request);
    return launch(prepared);
  }

  prepare(request: SandboxRunRequest = {}): SandboxLaunchOptions {
    const profile = request.profile ?? 'workspace';
    const root = request.workspaceRoot ? resolve(request.workspaceRoot) : undefined;
    const cwd = request.cwd ? resolve(request.cwd) : undefined;

    if (profile === 'readonly' && (request.writePaths?.length ?? 0) > 0) {
      throw new Error('readonly profile does not allow write paths');
    }
    if (root && this.capabilities.pathBoundary) {
      for (const path of [cwd, ...(request.readPaths ?? []), ...(request.writePaths ?? [])]) {
        if (path && !isWithin(root, path)) throw new Error(`path outside workspace root: ${path}`);
      }
    }

    const network = request.network ?? (request.needsNetwork ? 'full' : 'none');
    if (request.needsNetwork && network === 'none') throw new Error('network access is disabled');
    const degraded = !this.capabilities.osIsolation || (network !== 'none' && !this.capabilities.networkIsolation);

    return { profile, cwd, env: filterEnvironment(request.env ?? process.env, profile), network, degraded };
  }

  async stop(processLike: { kill?: () => unknown } | undefined): Promise<void> {
    if (!processLike?.kill) return;
    await processLike.kill();
  }

}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root.toLowerCase(), target.toLowerCase());
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function filterEnvironment(environment: NodeJS.ProcessEnv, profile: PermissionProfileName): NodeJS.ProcessEnv {
  if (profile === 'unrestricted') return { ...environment };
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (/(TOKEN|SECRET|PRIVATE_KEY|API_KEY|PASSWORD)/i.test(key)) continue;
    result[key] = value;
  }
  return result;
}

export function commandName(command: string): string {
  return basename(command).toLowerCase().replace(/\.exe$/, '');
}
