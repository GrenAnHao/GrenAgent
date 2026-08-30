import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class SettingsService {
  private readonly settingsPath: string;
  private readonly runtimePath: string;

  constructor(private readonly dataDir: string) {
    this.settingsPath = join(dataDir, 'settings.json');
    this.runtimePath = join(dataDir, 'runtime-settings.json');
  }

  async getAll(): Promise<Record<string, string>> {
    try {
      const value = JSON.parse(await readFile(this.settingsPath, 'utf8')) as unknown;
      return isSettings(value) ? value : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  async replace(settings: Record<string, string>): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await writeJsonAtomically(this.settingsPath, settings);
    await writeJsonAtomically(this.runtimePath, runtimeSettings(settings));
  }
}

function runtimeSettings(settings: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(settings).filter(([key, value]) =>
      !key.startsWith('TDAI_MEMORY_') && key !== 'TDAI_KNOWLEDGE_ENDPOINT' && value.trim().length > 0,
    ),
  );
}

function isSettings(value: unknown): value is Record<string, string> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === 'string');
}

async function writeJsonAtomically(path: string, value: Record<string, string>): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}
