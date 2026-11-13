import { randomUUID } from 'node:crypto';
import { readFastPreferences, writeFastPreference } from '../../../extensions/_shared/fast-mode-preferences.js';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelRuntime } from '../../../cli/src/pi-sdk.js';
import {
  interpolateHeaderPlaceholders,
  SETTINGS_PROBE_SESSION_ID,
} from '../../../extensions/_shared/header-placeholders.js';

type LoginInteraction = Parameters<ModelRuntime['login']>[2];

interface LoginOptions {
  getDeviceId: () => string;
  agentName?: string;
}

type ModelsLoginWithOptions = (
  providerId: string,
  type: 'oauth',
  interaction: LoginInteraction,
  options: LoginOptions,
) => Promise<unknown>;

const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 登录事件统一扁平化后推给渲染层；不携带 AbortSignal 等不可序列化对象。 */
export interface ProviderLoginUiEvent {
  loginId: string;
  providerId: string;
  type: 'info' | 'auth_url' | 'device_code' | 'progress' | 'prompt' | 'prompt_cancelled' | 'done' | 'error';
  message?: string;
  url?: string;
  instructions?: string;
  links?: readonly { url: string; label?: string }[];
  userCode?: string;
  verificationUri?: string;
  intervalSeconds?: number;
  expiresInSeconds?: number;
  promptId?: string;
  prompt?: {
    type: string;
    message: string;
    placeholder?: string;
    options?: readonly { id: string; label: string; description?: string }[];
  };
}

export interface RefreshResult {
  refreshed: string[];
  failed: Array<{ workspace: string; error: string }>;
}

/** 给渲染层的派生状态，不含 access / refresh 等令牌本体。 */
export interface ProviderCredentialStatus {
  providerId: string;
  type: 'api_key' | 'oauth';
  source: string | null;
  configured: boolean;
  expiresAt: number | null;
  isSubscription: boolean;
}

export interface ProviderOAuthCapability {
  providerId: string;
  name: string;
  loginLabel: string;
  isSubscription: boolean;
}

export interface ProviderServiceOptions {
  agentDir: string;
  probeModels?: () => Promise<string>;
  refresh?: () => Promise<RefreshResult>;
  fetch?: typeof fetch;
  /** 官方运行时，凭据写入、能力发现与登录编排都委托给它；未注入时相关命令报不可用。 */
  runtime?: () => Promise<ModelRuntime>;
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

interface ActiveLogin {
  loginId: string;
  providerId: string;
  controller: AbortController;
  prompts: Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>;
  emit: (event: ProviderLoginUiEvent) => void;
}

export class ProviderService {
  private readonly fetchImpl: typeof fetch;
  private readonly diagnoses = new Map<string, AbortController>();
  /** 官方 OAuth flow 争用固定回调端口与同一条 UI 通道，全局只允许一个登录流程。 */
  private activeLogin: ActiveLogin | undefined;
  private cachedDeviceId: string | undefined;

  constructor(private readonly options: ProviderServiceOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  getFastPreferences() {
    return readFastPreferences(this.options.agentDir);
  }

  setFastPreference(provider: string, modelId: string, enabled: boolean) {
    return writeFastPreference(this.options.agentDir, provider, modelId, enabled);
  }

  async getConfig(): Promise<{ modelsJson: string | null; authJson: string | null; agentDir: string }> {
    return {
      modelsJson: await readOptional(join(this.options.agentDir, 'models.json')),
      authJson: await readOptional(join(this.options.agentDir, 'auth.json')),
      agentDir: this.options.agentDir,
    };
  }

  /**
   * 只写 models.json。auth.json 归官方凭据存储所有：内置供应商的 API Key 走
   * setApiKey，OAuth 凭据走官方 login/logout，设置页保存不得触碰它们。
   */
  async setConfig(modelsJson: string): Promise<RefreshResult> {
    validateJson(modelsJson, 'models.json');
    await mkdir(this.options.agentDir, { recursive: true });
    await writeAtomically(join(this.options.agentDir, 'models.json'), modelsJson);
    return this.refresh();
  }

  /**
   * 显式写入/清除内置供应商的 API Key。官方 CredentialStore 按 providerId 只存一份凭据，
   * API Key 与 OAuth 互斥；清空时若当前是 OAuth 凭据则不动，避免把登录状态删掉。
   */
  async setApiKey(providerId: string, key: string | null): Promise<void> {
    const runtime = await this.requireRuntime();
    if (key === null) {
      const current = (await runtime.listCredentials()).find((c) => c.providerId === providerId);
      if (current && current.type !== 'api_key') return;
      await runtime.removeRuntimeApiKey(providerId);
      return;
    }
    await runtime.setRuntimeApiKey(providerId, key);
  }

  async getCredentials(): Promise<ProviderCredentialStatus[]> {
    const runtime = await this.requireRuntime();
    const [infos, providers, authRaw] = await Promise.all([
      runtime.listCredentials(),
      runtime.getProviders(),
      readOptional(join(this.options.agentDir, 'auth.json')),
    ]);
    const expires = parseCredentialExpires(authRaw);
    return infos.map((info) => {
      const status = runtime.getProviderAuthStatus(info.providerId);
      const oauth = providers.find((p) => p.id === info.providerId)?.auth.oauth;
      return {
        providerId: info.providerId,
        type: info.type,
        source: status.label ?? status.source ?? null,
        configured: status.configured,
        expiresAt: info.type === 'oauth' ? expires[info.providerId] ?? null : null,
        isSubscription: info.type === 'oauth' && (oauth?.isSubscription ?? false),
      };
    });
  }

  /** OAuth 能力从运行时探测；radius 需自建网关提供 OAuth 端点，不在官方厂商登录范围内。 */
  async getOAuthCapabilities(): Promise<ProviderOAuthCapability[]> {
    const runtime = await this.requireRuntime();
    return runtime.getProviders()
      .filter((p) => p.auth.oauth && p.id !== 'radius')
      .map((p) => ({
        providerId: p.id,
        name: p.auth.oauth!.name,
        loginLabel: p.auth.oauth!.loginLabel ?? p.auth.oauth!.name,
        isSubscription: p.auth.oauth!.isSubscription ?? false,
      }));
  }

  /** 本安装的稳定 UUID；落盘在 agentDir，目录不可写时退化为进程内稳定（不影响登录本身）。 */
  private async deviceId(): Promise<string> {
    if (this.cachedDeviceId) return this.cachedDeviceId;
    const path = join(this.options.agentDir, 'device-id.json');
    const raw = await readOptional(path);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { id?: unknown };
        if (typeof parsed.id === 'string' && DEVICE_ID_PATTERN.test(parsed.id)) {
          this.cachedDeviceId = parsed.id;
          return parsed.id;
        }
      } catch { /* 文件损坏则重建 */ }
    }
    const id = randomUUID();
    try {
      await mkdir(this.options.agentDir, { recursive: true });
      await writeAtomically(path, JSON.stringify({ id }, null, 2));
    } catch { /* 只读目录：至少保证本次运行内稳定 */ }
    this.cachedDeviceId = id;
    return id;
  }

  /**
   * 执行官方 OAuth 登录。登录期间的事件经 emit 推给渲染层；完成后刷新两份 runtime
   * 的凭据状态与可用模型（主进程与 agent 子进程各持一份 ModelRuntime）。
   */
  async startLogin(providerId: string, emit: (event: ProviderLoginUiEvent) => void): Promise<void> {
    if (this.activeLogin) throw new Error('已有登录流程正在进行，请先完成或取消');
    const loginId = randomUUID();
    const controller = new AbortController();
    const active: ActiveLogin = {
      loginId, providerId, controller,
      prompts: new Map(), emit,
    };
    this.activeLogin = active;
    // 立即把 loginId 交给渲染层，否则用户在首个授权事件到达前无法取消。
    emit({ loginId, providerId, type: 'progress', message: '正在准备登录…' });

    const interaction: LoginInteraction = {
      signal: controller.signal,
      notify: (event) => emit({ loginId, providerId, ...event } as ProviderLoginUiEvent),
      prompt: (request) => new Promise<string>((resolve, reject) => {
        const promptId = randomUUID();
        active.prompts.set(promptId, { resolve, reject });
        // 官方用 per-prompt signal 在浏览器回调先到达时取消「手动粘贴 code」输入。
        request.signal?.addEventListener('abort', () => {
          if (!active.prompts.delete(promptId)) return;
          emit({ loginId, providerId, type: 'prompt_cancelled', promptId });
          reject(new Error('Login prompt cancelled'));
        }, { once: true });
        const options = 'options' in request ? request.options : undefined;
        emit({
          loginId, providerId, type: 'prompt', promptId,
          prompt: {
            type: request.type,
            message: request.message,
            ...(request.placeholder ? { placeholder: request.placeholder } : {}),
            ...(options ? { options } : {}),
          },
        });
      }),
    };

    try {
      const runtime = await this.requireRuntime();
      const deviceId = await this.deviceId();
      await loginWithOptions(runtime, providerId, interaction, {
        getDeviceId: () => deviceId,
        agentName: 'GrenAgent',
      });
      await this.refresh();
      emit({ loginId, providerId, type: 'done' });
    } catch (error) {
      if (!controller.signal.aborted) {
        emit({
          loginId, providerId, type: 'error',
          message: describeProviderLoginError(error instanceof Error ? error.message : String(error)),
        });
      }
    } finally {
      // 取消/结束都要清掉悬挂的 prompt，避免渲染层留着输入框或 Promise 永不 resolve。
      for (const [, pending] of active.prompts) pending.reject(new Error('Login finished'));
      active.prompts.clear();
      if (this.activeLogin === active) this.activeLogin = undefined;
    }
  }

  /** 渲染层提交一次交互输入，使官方 flow 中等待的 prompt() 继续。 */
  respondPrompt(promptId: string, value: string): void {
    const active = this.activeLogin;
    const pending = active?.prompts.get(promptId);
    if (!active || !pending) return;
    active.prompts.delete(promptId);
    pending.resolve(value);
  }

  cancelLogin(loginId: string): void {
    const active = this.activeLogin;
    if (!active || active.loginId !== loginId) return;
    active.controller.abort();
    for (const [, pending] of active.prompts) pending.reject(new Error('Login cancelled'));
    active.prompts.clear();
    active.emit({ loginId, providerId: active.providerId, type: 'error', message: '登录已取消' });
  }

  async logout(providerId: string): Promise<void> {
    const runtime = await this.requireRuntime();
    await runtime.logout(providerId);
    await this.refresh();
  }

  private requireRuntime(): Promise<ModelRuntime> {
    if (!this.options.runtime) return Promise.reject(new Error('Model runtime is unavailable'));
    return this.options.runtime();
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
    error = describeProviderAuthError(error);
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

/**
 * pi-coding-agent 1.4.0 的 ModelRuntime.login 只收 3 个参数，丢掉了底层
 * Models.login 的 LoginOptions；OpenAI ChatGPT flow 需要 getDeviceId，否则直接抛
 * "requires a device ID (UUID)"。这里优先走同一实例内的 Models 集合以传完整 options；
 * 上游修好封装后可删除这条适配。内部结构变化时失败关闭，退回公开 login。
 */
async function loginWithOptions(
  runtime: ModelRuntime,
  providerId: string,
  interaction: LoginInteraction,
  options: LoginOptions,
): Promise<void> {
  const models = (runtime as unknown as { models?: { login?: ModelsLoginWithOptions } }).models;
  if (typeof models?.login === 'function') {
    await models.login(providerId, 'oauth', interaction, options);
    return;
  }
  await runtime.login(providerId, 'oauth', interaction);
}

/** 把官方英文 OAuth 错误转成可操作的中文提示，界面不再直接显示英文异常。 */
export function describeProviderLoginError(message: string): string {
  if (/requires a device ID/i.test(message)) {
    return '登录失败：本安装缺少稳定的设备标识（UUID）。请重试；若反复出现，检查 agentDir 下 device-id.json 是否可写。';
  }
  if (/Port \d+ is in use/i.test(message)) {
    return '登录失败：本地回调端口被占用，可能有未结束的登录或 Codex CLI 正在运行。请先取消其它登录再重试。';
  }
  if (/invalid_grant|access_denied|expired/i.test(message)) {
    return '登录失败：授权被拒绝或已过期，请重新登录。';
  }
  return `登录失败：${message}`;
}

/**
 * 官方 ModelsError(code="oauth") 保留原凭据并抛错；这里只把错误文案换成可操作的
 * 「重新登录」提示，不删除凭据、不在请求路径上打开登录界面。其它错误原样返回。
 */
export function describeProviderAuthError(message: string | null): string | null {
  if (!message) return null;
  if (/invalid_grant|code["':=\s]*oauth|ModelsError.*oauth|oauth.*refresh.*fail|refresh token.*(?:invalid|expired|revoked)/i.test(message)) {
    return '登录已过期或刷新失败，请在该供应商的账号卡重新登录（原凭据已保留，不会自动登出）。';
  }
  return message;
}

/** 只读 OAuth 凭据的 expires 元数据，绝不把 access / refresh 带进返回值。 */
function parseCredentialExpires(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw) as Record<string, { type?: unknown; expires?: unknown } | null>;
    return Object.fromEntries(Object.entries(data)
      .filter(([, v]) => v?.type === 'oauth' && typeof v.expires === 'number')
      .map(([k, v]) => [k, v!.expires as number]));
  } catch {
    return {};
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
