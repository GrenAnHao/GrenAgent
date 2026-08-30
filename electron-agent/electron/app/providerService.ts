import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface RefreshResult {
  refreshed: string[];
  failed: Array<{ workspace: string; error: string }>;
}

export interface ProviderServiceOptions {
  agentDir: string;
  probeModels?: () => Promise<string>;
  refresh?: () => Promise<RefreshResult>;
}

export class ProviderService {
  constructor(private readonly options: ProviderServiceOptions) {}

  async getConfig(): Promise<{ modelsJson: string | null; authJson: string | null; agentDir: string }> {
    return {
      modelsJson: await readOptional(join(this.options.agentDir, 'models.json')),
      authJson: await readOptional(join(this.options.agentDir, 'auth.json')),
      agentDir: this.options.agentDir,
    };
  }

  async setConfig(modelsJson: string, authJson: string): Promise<RefreshResult> {
    validateJson(modelsJson, 'models.json');
    validateJson(authJson, 'auth.json');
    await mkdir(this.options.agentDir, { recursive: true });
    await Promise.all([
      writeAtomically(join(this.options.agentDir, 'models.json'), modelsJson),
      writeAtomically(join(this.options.agentDir, 'auth.json'), authJson),
    ]);
    return this.refresh();
  }

  refresh(): Promise<RefreshResult> {
    return this.options.refresh?.() ?? Promise.resolve({ refreshed: [], failed: [] });
  }

  async listModels(): Promise<unknown[]> {
    if (!this.options.probeModels) throw new Error('Pi model probe is unavailable');
    const output = JSON.parse(await this.options.probeModels()) as { ok?: unknown; models?: unknown; error?: unknown };
    if (output.ok !== true || !Array.isArray(output.models)) {
      throw new Error(typeof output.error === 'string' ? output.error : 'Pi model probe failed');
    }
    return output.models;
  }
}

function validateJson(content: string, file: string): void {
  try {
    JSON.parse(content);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeAtomically(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}
