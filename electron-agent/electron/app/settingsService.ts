import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

function workspaceConfigSuffix(workspace: string): string {
  return workspace.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function approvalPolicyConfigKey(workspace: string): string {
  return `APPROVAL_POLICY:${workspaceConfigSuffix(workspace)}`;
}

export function isApprovalPolicyConfigKey(key: string): boolean {
  return key === 'APPROVAL_POLICY' || key.startsWith('APPROVAL_POLICY:');
}

export function contextExclusionConfigKey(workspace: string): string {
  return `CONTEXT_EXCLUSION_OP:${workspaceConfigSuffix(workspace)}`;
}

export function isContextExclusionConfigKey(key: string): boolean {
  return key.startsWith('CONTEXT_EXCLUSION_OP:');
}

export function isPreservedRuntimeConfigKey(key: string): boolean {
  return isApprovalPolicyConfigKey(key) || isContextExclusionConfigKey(key);
}

const runtimeFileWrites = new Map<string, Promise<void>>();

function withRuntimeFileLock(path: string, write: () => Promise<void>): Promise<void> {
  const previous = runtimeFileWrites.get(path) ?? Promise.resolve();
  const current = previous.then(write, write);
  runtimeFileWrites.set(path, current);
  return current.finally(() => {
    if (runtimeFileWrites.get(path) === current) runtimeFileWrites.delete(path);
  });
}

export async function mergeRuntimeSettingsFile(path: string, patch: Record<string, string>): Promise<void> {
  await withRuntimeFileLock(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    const current = await readSettingsFile(path);
    await writeJsonAtomically(path, { ...current, ...runtimeSettings(patch) });
  });
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
    await withRuntimeFileLock(this.runtimePath, async () => {
      const existingRuntime = await readSettingsFile(this.runtimePath);
      const preservedLive = Object.fromEntries(
        Object.entries(existingRuntime).filter(([key]) => isPreservedRuntimeConfigKey(key)),
      );
      await writeJsonAtomically(this.runtimePath, { ...runtimeSettings(settings), ...preservedLive });
    });
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
