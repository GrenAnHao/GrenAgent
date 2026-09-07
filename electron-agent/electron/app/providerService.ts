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
  activeModel?: (workspace: string) => Promise<{ provider: string; modelId: string }>;
  oneshot?: (request: Record<string, unknown>, onLine?: (line: string) => void) => Promise<void>;
}

export interface DiagnoseResult {
  ok: boolean;
  error: string | null;
  content: string;
  ttftMs: number;
  totalMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  tokensPerSec: number | null;
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

  async fetchModels(baseUrl: string, apiKey: string, api: string, headers?: Record<string, string>): Promise<string[]> {
    const base = baseUrl.trim().replace(/\/$/, '');
    const key = apiKey.trim();
    if (!base) throw new Error('Base URL is required');
    if (!key) throw new Error('API Key is required');
    // 自定义供应商常见于二手代理站，其 WAF 会按请求头（尤其 UA）识别真实客户端；models.json 里配置的
    // 自定义 headers（如中性 User-Agent）会应用到真实对话请求，这里的探测请求必须带上同一套 headers，
    // 否则探测请求会因「看起来不像真实客户端」被拒（表现为供应商侧返回的 401/Invalid token，
    // 密钥本身其实有效）。认证头（authorization/x-api-key）不可被自定义 headers 覆盖。
    const extra = withoutAuthHeaders(headers);
    if (api === 'anthropic-messages') {
      const data = await this.getJson(`${base.endsWith('/v1') ? base : `${base}/v1`}/models`, {
        ...extra, 'x-api-key': key, 'anthropic-version': '2023-06-01',
      });
      return readModelIds(data);
    }
    if (api === 'google-generative-ai') {
      const data = await this.getJson(`${base.endsWith('/v1beta') || base.endsWith('/v1') ? base : `${base}/v1beta`}/models?key=${encodeURIComponent(key)}`, extra);
      if (!data || typeof data !== 'object' || !Array.isArray((data as Record<string, unknown>).models)) throw new Error('Provider response does not contain models');
      return (data as { models: Array<{ name?: unknown }> }).models.flatMap(({ name }) => typeof name === 'string' ? [name.replace(/^models\//, '')] : []);
    }
    const candidates = base.endsWith('/v1') ? [`${base}/models`] : [`${base}/v1/models`, `${base}/models`];
    let lastError: unknown;
    for (const url of candidates) {
      try { return readModelIds(await this.getJson(url, { ...extra, authorization: `Bearer ${key}` })); }
      catch (error) { lastError = error; }
    }
    throw lastError instanceof Error ? lastError : new Error('Provider model request failed');
  }

  async fixMermaid(workspace: string, code: string, error: string): Promise<string> {
    if (!this.options.activeModel || !this.options.oneshot) throw new Error('Pi oneshot runtime is unavailable');
    const model = await this.options.activeModel(workspace);
    let output = '';
    await this.options.oneshot({
      provider: model.provider, modelId: model.modelId,
      system: 'Repair the Mermaid source. Reply only with corrected Mermaid code in one mermaid fenced block.',
      user: `Mermaid error:\n${error}\n\nSource:\n\`\`\`mermaid\n${code}\n\`\`\``,
    }, (line) => { output = line; });
    const result = parseOneshot(output);
    if (!result.ok) throw new Error(result.error || 'oneshot failed');
    const fixed = extractMermaid(result.content ?? '');
    if (!fixed) throw new Error('model returned no Mermaid code');
    return fixed;
  }

  async diagnose(providerId: string, modelId: string, prompt: string, stream: boolean, onChunk: (chunk: string) => void): Promise<DiagnoseResult> {
    if (!this.options.oneshot) throw new Error('Pi oneshot runtime is unavailable');
    const started = Date.now();
    let content = ''; let error: string | null = null; let ttftMs = 0; let first = false;
    let usage: Record<string, unknown> = {};
    await this.options.oneshot({ provider: providerId, modelId, user: prompt.trim() || 'Who are you?', stream }, (line) => {
      const result = parseOneshot(line);
      if (result.type === 'delta' && typeof result.text === 'string') {
        if (!first) { first = true; ttftMs = Date.now() - started; }
        content += result.text; onChunk(result.text); return;
      }
      if (result.type === 'error') { error = result.error || 'oneshot failed'; return; }
      if (result.type === 'done') { usage = result.usage ?? {}; return; }
      if (result.ok === false) { error = result.error || 'oneshot failed'; return; }
      if (result.ok === true) { content = result.content ?? ''; usage = result.usage ?? {}; }
    });
    const totalMs = Date.now() - started;
    const completionTokens = numberValue(usage.completion_tokens);
    return {
      ok: error === null, error, content, ttftMs, totalMs,
      promptTokens: numberValue(usage.prompt_tokens), completionTokens, totalTokens: numberValue(usage.total_tokens),
      tokensPerSec: completionTokens !== null && totalMs > 0 ? completionTokens / (totalMs / 1000) : null,
    };
  }

  private async getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
    const response = await this.fetchImpl(url, { headers });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300).trim()}`);
    try { return JSON.parse(text); } catch { throw new Error(`Provider response is not valid JSON: ${text.slice(0, 300).trim()}`); }
  }
}

function parseOneshot(line: string): Record<string, any> {
  try { return JSON.parse(line) as Record<string, any>; } catch { return { ok: false, error: `oneshot output is not valid JSON: ${line}` }; }
}

function extractMermaid(content: string): string {
  const match = content.trim().match(/```(?:mermaid)?\s*\n?([\s\S]*?)```/i);
  return (match?.[1] ?? content).trim();
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 剔除认证类 header（大小写不敏感），确保用户自定义 headers 不会意外覆盖真正的鉴权凭据。 */
function withoutAuthHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  const reserved = new Set(['authorization', 'x-api-key', 'x-goog-api-key']);
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !reserved.has(k.toLowerCase())));
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
