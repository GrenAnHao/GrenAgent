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
  fetch?: typeof fetch;
}

export class ProviderService {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ProviderServiceOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

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

  async fetchModels(baseUrl: string, apiKey: string, api: string): Promise<string[]> {
    const base = baseUrl.trim().replace(/\/$/, '');
    const key = apiKey.trim();
    if (!base) throw new Error('Base URL is required');
    if (!key) throw new Error('API Key is required');
    if (api === 'anthropic-messages') {
      const data = await this.getJson(`${base.endsWith('/v1') ? base : `${base}/v1`}/models`, {
        'x-api-key': key, 'anthropic-version': '2023-06-01',
      });
      return readModelIds(data);
    }
    if (api === 'google-generative-ai') {
      const data = await this.getJson(`${base.endsWith('/v1beta') || base.endsWith('/v1') ? base : `${base}/v1beta`}/models?key=${encodeURIComponent(key)}`);
      if (!data || typeof data !== 'object' || !Array.isArray((data as Record<string, unknown>).models)) throw new Error('Provider response does not contain models');
      return (data as { models: Array<{ name?: unknown }> }).models.flatMap(({ name }) => typeof name === 'string' ? [name.replace(/^models\//, '')] : []);
    }
    const candidates = base.endsWith('/v1') ? [`${base}/models`] : [`${base}/v1/models`, `${base}/models`];
    let lastError: unknown;
    for (const url of candidates) {
      try { return readModelIds(await this.getJson(url, { authorization: `Bearer ${key}` })); }
      catch (error) { lastError = error; }
    }
    throw lastError instanceof Error ? lastError : new Error('Provider model request failed');
  }

  private async getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
    const response = await this.fetchImpl(url, { headers });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300).trim()}`);
    try { return JSON.parse(text); } catch { throw new Error(`Provider response is not valid JSON: ${text.slice(0, 300).trim()}`); }
  }
}

function readModelIds(value: unknown): string[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as Record<string, unknown>).data)) throw new Error('Provider response does not contain data models');
  return (value as { data: Array<{ id?: unknown }> }).data.flatMap(({ id }) => typeof id === 'string' ? [id] : []);
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
