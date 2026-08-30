import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface TencentDbLayoutOptions {
  resourcesPath: string;
  appPath: string;
  isPackaged: boolean;
  platform?: NodeJS.Platform;
  arch?: string;
}

function platformDir(platform: NodeJS.Platform = process.platform, arch = process.arch): string {
  if (platform === 'win32' && arch === 'x64') return 'windows-x86_64';
  if (platform === 'win32' && arch === 'arm64') return 'windows-aarch64';
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-aarch64';
  if (platform === 'darwin') return 'darwin-x86_64';
  if (arch === 'arm64') return 'linux-aarch64';
  return 'linux-x86_64';
}

export class TencentDbLayout {
  readonly root: string;
  constructor(options: TencentDbLayoutOptions) {
    const bundled = join(options.resourcesPath, 'tencentdb-memory', platformDir(options.platform, options.arch));
    const development = join(options.appPath, 'resources', 'tencentdb-memory', platformDir(options.platform, options.arch));
    this.root = options.isPackaged || existsSync(bundled) ? bundled : development;
  }

  node(): string {
    return process.platform === 'win32'
      ? join(this.root, 'node', 'node.exe')
      : join(this.root, 'node', 'bin', 'node');
  }

  coreEntry(): string {
    return join(this.root, 'core', 'src', 'gateway', 'server.ts');
  }

  knowledgeEntry(): string {
    return join(this.root, 'knowledge', 'bin', 'server.mjs');
  }

  coreConfig(): string {
    return join(this.root, 'core', 'tdai-gateway.standalone.yaml');
  }

  panelEntry(): string {
    return join(this.root, 'panel', 'dist', 'index.js');
  }

  assertReady(): void {
    for (const path of [this.node(), this.coreEntry(), this.knowledgeEntry(), this.coreConfig(), this.panelEntry()]) {
      if (!existsSync(path)) throw new Error(`TencentDB bundled runtime entry is missing: ${path}`);
    }
  }

  assertCoreReady(): void {
    for (const path of [this.node(), this.coreEntry(), this.knowledgeEntry(), this.coreConfig()]) {
      if (!existsSync(path)) throw new Error(`TencentDB bundled runtime entry is missing: ${path}`);
    }
  }
}

export { platformDir };
