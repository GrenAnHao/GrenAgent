import { DefaultPackageManager, SettingsManager, type PackageSource } from '../../../cli/src/pi-sdk.js';
import { filterExtensionsByProfile, filterManagedExtensions, type ExtensionProfile } from '../../../cli/src/extension-profile.js';
import {
  findRawEntry,
  isPackageEnabled,
  isValidNpmName,
  isValidSemver,
  mapNpmSearchPayload,
  npmNameFromSource,
  pinNpmSource,
  replacePackageEntry,
  sanitizeSearchQuery,
  withAutoload,
  type PackageListItem,
  type PackageSearchResult,
} from './piPackageModel';

export interface SettingsPort {
  getGlobalSettings(): { packages?: PackageSource[] };
  getProjectSettings(): { packages?: PackageSource[] };
  setPackages(packages: PackageSource[]): void;
  setProjectPackages(packages: PackageSource[]): void;
}

export interface PackageManagerPort {
  listConfiguredPackages(): Array<{ source: string; scope: 'user' | 'project'; filtered: boolean }>;
  installAndPersist(source: string, options?: { local?: boolean }): Promise<void>;
  removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean>;
}

export interface PiPackageServiceOptions {
  agentDir: string;
  allowedPluginIds: () => string[];
  /**
   * 内置扩展清单。主进程传向 agent-host 子进程要清单的函数：静态引入 extensions/index.js
   * 会把全部扩展模块加载进主进程。不传时按需动态引入（测试与单进程场景）。
   */
  extensions?: BuiltinExtensionEntry[] | (() => Promise<BuiltinExtensionEntry[]>);
  profile?: ExtensionProfile;
  createSettingsManager?: (cwd: string, agentDir: string) => SettingsPort;
  createPackageManager?: (input: { cwd: string; agentDir: string; settingsManager: SettingsPort }) => PackageManagerPort;
  fetchImpl?: typeof fetch;
  /** 让运行中的会话重载资源。运行时在 agent-host 子进程里，主进程传 RPC。 */
  requestReload?: () => boolean | Promise<boolean>;
}

type BuiltinExtensionEntry = { name: string; manifest?: { id: string } };

export class PiPackageService {
  private readonly agentDir: string;
  private readonly allowedPluginIds: () => string[];
  private readonly extensions: () => Promise<BuiltinExtensionEntry[]>;
  private readonly profile: ExtensionProfile;
  private readonly createSettingsManager: (cwd: string, agentDir: string) => SettingsPort;
  private readonly createPackageManager: (input: { cwd: string; agentDir: string; settingsManager: SettingsPort }) => PackageManagerPort;
  private readonly fetchImpl: typeof fetch;
  private readonly requestReload: () => boolean | Promise<boolean>;

  constructor(options: PiPackageServiceOptions) {
    this.agentDir = options.agentDir;
    this.allowedPluginIds = options.allowedPluginIds;
    const extensions = options.extensions;
    this.extensions = typeof extensions === 'function'
      ? extensions
      : extensions
        ? async () => extensions
        : async () => (await import('../../../extensions/index.js')).manifestExtensions;
    this.profile = options.profile ?? 'project';
    this.createSettingsManager = options.createSettingsManager
      ?? ((cwd, agentDir) => SettingsManager.create(cwd, agentDir));
    this.createPackageManager = options.createPackageManager
      ?? ((input) => new DefaultPackageManager(input as { cwd: string; agentDir: string; settingsManager: SettingsManager }));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestReload = options.requestReload
      ?? (async () => (await import('../../../extensions/_shared/resource-reload.js')).requestResourceReload());
  }

  async search(query: string): Promise<PackageSearchResult> {
    const cleaned = sanitizeSearchQuery(query);
    const text = cleaned ? `keywords:pi-package ${cleaned}` : 'keywords:pi-package';
    const url = `https://registry.npmjs.org/-/v1/search?${new URLSearchParams({ text, size: '20' })}`;
    const response = await this.fetchImpl(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return mapNpmSearchPayload(await response.json());
  }

  async list(workspace: string): Promise<PackageListItem[]> {
    const loaded = filterManagedExtensions(
      filterExtensionsByProfile(await this.extensions(), this.profile),
      JSON.stringify(this.allowedPluginIds()),
    );
    const builtins: PackageListItem[] = loaded.map((entry) => ({
      kind: 'builtin',
      id: entry.name,
      title: entry.name,
      scope: 'product',
      enabled: true,
      canDisable: false,
      canRemove: false,
    }));
    const { settings, packages } = this.open(workspace);
    const configured = packages.listConfiguredPackages()
      .filter((entry) => workspace.trim() || entry.scope === 'user');
    const mapped: PackageListItem[] = configured.map((entry) => {
      const raw = findRawEntry(
        entry.scope === 'project' ? settings.getProjectSettings().packages : settings.getGlobalSettings().packages,
        entry.source,
      );
      return {
        kind: 'package',
        id: entry.source,
        title: npmNameFromSource(entry.source),
        scope: entry.scope,
        enabled: raw ? isPackageEnabled(raw) : true,
        canDisable: true,
        canRemove: true,
      };
    });
    return [...builtins, ...mapped];
  }

  async setEnabled(workspace: string, source: string, scope: 'user' | 'project', enabled: boolean): Promise<void> {
    this.assertProjectWorkspace(workspace, scope);
    const { settings } = this.open(workspace);
    if (scope === 'user') {
      const current = settings.getGlobalSettings().packages ?? [];
      const matched = findRawEntry(current, source);
      if (!matched) throw new Error('PACKAGE_NOT_FOUND');
      settings.setPackages(replacePackageEntry(current, source, withAutoload(matched, enabled)));
    } else {
      const current = settings.getProjectSettings().packages ?? [];
      const matched = findRawEntry(current, source);
      if (!matched) throw new Error('PACKAGE_NOT_FOUND');
      settings.setProjectPackages(replacePackageEntry(current, source, withAutoload(matched, enabled)));
    }
    await this.requestReload();
  }

  async install(workspace: string, name: string, version: string, scope: 'user' | 'project'): Promise<void> {
    this.assertProjectWorkspace(workspace, scope);
    if (!isValidNpmName(name) || !isValidSemver(version)) throw new Error('INVALID_PACKAGE');
    const { packages } = this.open(workspace);
    await packages.installAndPersist(pinNpmSource(name, version), { local: scope === 'project' });
    await this.requestReload();
  }

  async remove(workspace: string, source: string, scope: 'user' | 'project'): Promise<void> {
    this.assertProjectWorkspace(workspace, scope);
    const { packages } = this.open(workspace);
    await packages.removeAndPersist(source, { local: scope === 'project' });
    await this.requestReload();
  }

  private assertProjectWorkspace(workspace: string, scope: 'user' | 'project'): void {
    if (scope === 'project' && !workspace.trim()) throw new Error('请先打开项目');
  }

  private open(workspace: string): { cwd: string; settings: SettingsPort; packages: PackageManagerPort } {
    const cwd = workspace.trim() || this.agentDir;
    const settings = this.createSettingsManager(cwd, this.agentDir);
    const packages = this.createPackageManager({ cwd, agentDir: this.agentDir, settingsManager: settings });
    return { cwd, settings, packages };
  }
}
