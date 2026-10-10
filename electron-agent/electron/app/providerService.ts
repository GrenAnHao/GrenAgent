import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  interpolateHeaderPlaceholders,
  SETTINGS_PROBE_SESSION_ID,
} from '../../../extensions/_shared/header-placeholders.js';

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
  oneshot?: (request: Record<string, unknown>, onLine?: (line: string) => void, signal?: AbortSignal) => Promise<void>;
}

export interface DiagnoseRequest {
  /** 渲染层生成；取消时按它找到这一次请求。 */
  requestId: string;
  providerId: string;
  modelId: string;
  prompt: string;
  /** true：输出边到边推给渲染层；false：只在结果里给全文。线上都走流式（pi-ai 的 completeSimple 也是流式）。 */
  stream: boolean;
  /** pi 思考档（minimal…max）。不传 = 关闭思考。 */
  reasoning?: string;
}

export interface DiagnoseChunk {
  type: 'text' | 'thinking';
  text: string;
}

export interface DiagnoseResult {
  ok: boolean;
  cancelled: boolean;
  error: string | null;
  content: string;
  thinking: string;
  /** 首个输出（思考或正文）到达的耗时；没有任何输出时为 0。 */
  ttftMs: number;
  totalMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  /** 思考 token，包含在 completionTokens 里；供应商不报时为 null。 */
  reasoningTokens: number | null;
  totalTokens: number | null;
  tokensPerSec: number | null;
}

export class ProviderService {
  private readonly fetchImpl: typeof fetch;
  private readonly diagnoses = new Map<string, AbortController>();

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
    interpolateHeaderPlaceholders(extra, { sessionId: SETTINGS_PROBE_SESSION_ID });
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

  async diagnose(request: DiagnoseRequest, onChunk: (chunk: DiagnoseChunk) => void): Promise<DiagnoseResult> {
    if (!this.options.oneshot) throw new Error('Pi oneshot runtime is unavailable');
    this.abortDiagnose(request.requestId);
    const controller = new AbortController();
    this.diagnoses.set(request.requestId, controller);
    const { signal } = controller;
    const started = Date.now();
    let content = ''; let thinking = ''; let error: string | null = null; let ttftMs = 0; let first = false;
    let usage: Record<string, unknown> = {};
    const output = (type: DiagnoseChunk['type'], text: string) => {
      if (!first) { first = true; ttftMs = Date.now() - started; }
      if (type === 'text') content += text; else thinking += text;
      if (request.stream) onChunk({ type, text });
    };
    // 思考档只在流式路径生效（host.completeSimple 有意丢掉 reasoning），所以测活一律走流式。
    const run = this.options.oneshot({
      provider: request.providerId,
      modelId: request.modelId,
      user: request.prompt.trim() || 'Who are you?',
      stream: true,
      ...(request.reasoning ? { reasoning: request.reasoning } : {}),
    }, (line) => {
      if (signal.aborted) return;
      const result = parseOneshot(line);
      if (result.type === 'delta' && typeof result.text === 'string') { output('text', result.text); return; }
      if (result.type === 'thinking' && typeof result.text === 'string') { output('thinking', result.text); return; }
      if (result.type === 'error') { error = result.error || 'oneshot failed'; usage = result.usage ?? usage; return; }
      if (result.type === 'done') { usage = result.usage ?? {}; return; }
      if (result.ok === false) error = result.error || 'oneshot failed';
    }, signal).catch((e: unknown) => { error = e instanceof Error ? e.message : String(e); });
    try {
      // 供应商卡在连接上时 stream 未必响应 signal；取消以 abort 为准立即返回，不等它收尾。
      await Promise.race([run, abortedPromise(signal)]);
    } finally {
      if (this.diagnoses.get(request.requestId) === controller) this.diagnoses.delete(request.requestId);
    }
    const totalMs = Date.now() - started;
    const tokens = readUsage(usage);
    if (signal.aborted) {
      return { ok: false, cancelled: true, error: null, content, thinking, ttftMs, totalMs, ...tokens, tokensPerSec: null };
    }
    if (error === null && !content.trim()) error = thinking.trim() ? '模型只返回了思考，没有正文' : '模型返回了空内容';
    return {
      ok: error === null, cancelled: false, error, content, thinking, ttftMs, totalMs, ...tokens,
      tokensPerSec: tokens.completionTokens !== null && totalMs > 0 ? tokens.completionTokens / (totalMs / 1000) : null,
    };
  }

  /** 取消一次测活；requestId 不在飞时什么都不做。 */
  abortDiagnose(requestId: string): void {
    this.diagnoses.get(requestId)?.abort();
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

/** pi-ai 的 Usage 是 input / output / reasoning / totalTokens；OpenAI 原生字段名留作兜底。 */
function readUsage(usage: Record<string, unknown>): Pick<DiagnoseResult, 'promptTokens' | 'completionTokens' | 'reasoningTokens' | 'totalTokens'> {
  return {
    promptTokens: numberValue(usage.input) ?? numberValue(usage.prompt_tokens),
    completionTokens: numberValue(usage.output) ?? numberValue(usage.completion_tokens),
    reasoningTokens: numberValue(usage.reasoning),
    totalTokens: numberValue(usage.totalTokens) ?? numberValue(usage.total_tokens),
  };
}

function abortedPromise(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
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
