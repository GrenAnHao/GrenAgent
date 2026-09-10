import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

function workspaceConfigSuffix(workspace: string): string {
  return workspace.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** 与 sidecar `extensions/_shared/approval.ts` 的键规则保持一致。 */
export function approvalPolicyConfigKey(workspace: string): string {
  return `APPROVAL_POLICY:${workspaceConfigSuffix(workspace)}`;
}

/** 与 sidecar `extensions/compaction-policy/exclusion.ts` 的键规则保持一致。 */
export function contextExclusionConfigKey(workspace: string): string {
  return `CONTEXT_EXCLUSION_OP:${workspaceConfigSuffix(workspace)}`;
}

export async function mergeRuntimeSettingsFile(path: string, patch: Record<string, string>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const current = await readSettingsFile(path);
  await writeJsonAtomically(path, { ...current, ...runtimeSettings(patch) });
}

export class SettingsService {
  private readonly settingsPath: string;
  private readonly runtimePath: string;
  private readonly appStatePath: string;

  constructor(
    private readonly dataDir: string,
    private readonly legacyDataDirs: readonly string[] = [],
  ) {
    this.settingsPath = join(dataDir, 'settings.json');
    this.runtimePath = join(dataDir, 'runtime-settings.json');
    this.appStatePath = join(dataDir, 'app-state.json');
  }

  async getAll(): Promise<Record<string, string>> {
    const appStateSettings = await readAppStateSettings(this.appStatePath);
    const legacySettings = await readFirstSettings(this.legacyDataDirs);
    const localSettings = await readSettingsFile(this.settingsPath);
    return { ...legacySettings, ...appStateSettings, ...localSettings };
  }

  async replace(settings: Record<string, string>): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await writeAppStateSettings(this.appStatePath, settings);
    await writeJsonAtomically(this.settingsPath, settings);
    await writeJsonAtomically(this.runtimePath, runtimeSettings(settings));
  }
}

async function readSettingsFile(path: string): Promise<Record<string, string>> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return isSettings(value) ? value : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

// 旧数据目录（如重命名前的 com.rxstudio.grenagent）可能只有 app-state.json 或只有 settings.json，
// 两种形态都尝试，取第一个非空结果。
async function readFirstSettings(dataDirs: readonly string[]): Promise<Record<string, string>> {
  for (const dataDir of dataDirs) {
    const fromAppState = await readAppStateSettings(join(dataDir, 'app-state.json'));
    if (Object.keys(fromAppState).length > 0) return fromAppState;
    const settings = await readSettingsFile(join(dataDir, 'settings.json'));
    if (Object.keys(settings).length > 0) return settings;
  }
  return {};
}

async function readAppStateSettings(path: string): Promise<Record<string, string>> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const settings = (value as Record<string, unknown>).settings;
    return isSettings(settings) ? settings : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

async function writeAppStateSettings(path: string, settings: Record<string, string>): Promise<void> {
  let state: Record<string, unknown> = {};
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) state = value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeJsonAtomically(path, { ...state, settings });
}

function runtimeSettings(settings: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(settings).filter(([key, value]) =>
      value.trim().length > 0 && !/^TDAI_|^TENCENTDB_/i.test(key),
    ),
  );
}

function isSettings(value: unknown): value is Record<string, string> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === 'string');
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}
