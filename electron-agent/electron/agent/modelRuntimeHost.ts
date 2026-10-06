import type { ModelRuntime } from '../../../cli/src/pi-sdk.js';
import type { ThinkingLevel } from '@earendil-works/pi-ai';
import { formatNonStream } from '../../../extensions/_shared/oneshot.js';

type Model = NonNullable<ReturnType<ModelRuntime['getModel']>>;

export interface ShortCallInput {
  user: string;
  systemPrompt?: string;
  model?: Model;
  provider?: string;
  modelId?: string;
  signal?: AbortSignal;
  /** 采样温度。不传则跑在 provider 默认值上（DeepSeek 默认 1.0，改写/抽取类任务会明显加戏）。 */
  temperature?: number;
  /** 推理档位。改写/抽取类任务传 'minimal'，压低模型输出自我解说（改动说明/对照表）的倾向。 */
  reasoning?: ThinkingLevel;
  /**
   * 额外采样参数，经 OpenAI 兼容适配器原样合并进请求体（如 top_p / top_k）。
   * 不传则不覆盖 provider/模型默认；非 OpenAI 兼容 API 会忽略。
   */
  samplingParams?: Record<string, unknown>;
  /** 输出 token 上限。记忆抽取 / 去重传 4096（上游 config.ts:652）；不传则用模型默认。 */
  maxTokens?: number;
  /**
   * completeSimple 拿到模型响应后立刻回报用量，先于文本校验：空内容、provider 报错的那次也花了钱。
   * 这些调用不写 session JSONL，用量面板看不到，只能靠调用方自己记。
   */
  onUsage?: (report: { model: string; usage: unknown }) => void;
}

export interface ModelRuntimeHostOptions {
  /** 注入点仅为可测性；生产传 () => ModelRuntime.create({ authPath, modelsPath })。 */
  create: () => Promise<ModelRuntime>;
  /** 读 userData 下的默认模型。生产：SettingsManager.create(userDataCwd, agentDir)。 */
  resolveSettings?: () => Promise<{ provider: string; modelId: string }>;
}

/**
 * 进程内唯一的 ModelRuntime。今日每个 sidecar 各持一份；进程内嵌后鉴权与模型表只需一份，
 * 由各 WorkspaceHandle 共用。
 */
export class ModelRuntimeHost {
  private runtime: ModelRuntime | undefined;
  private pending: Promise<ModelRuntime> | undefined;

  constructor(private readonly options: ModelRuntimeHostOptions) {}

  async ensure(): Promise<ModelRuntime> {
    if (this.runtime) return this.runtime;
    if (!this.pending) {
      this.pending = this.options.create()
        .then((runtime) => { this.runtime = runtime; return runtime; })
        .finally(() => { this.pending = undefined; });
    }
    return this.pending;
  }

  /** provider 配置 / models.json 变更后调用：原地重读，不丢弃实例（在飞 session 持有同一引用）。 */
  async refresh(): Promise<void> {
    const runtime = await this.ensure();
    await runtime.refresh();
  }

  peek(): ModelRuntime | undefined {
    return this.runtime;
  }

  async resolveDefaultModel(): Promise<Model> {
    const runtime = await this.ensure();
    const { provider, modelId } = await this.settings();
    const configured = runtime.getModel(provider, modelId);
    if (configured && runtime.hasConfiguredAuth(provider)) return configured;
    const first = runtime.getAvailableSnapshot()[0];
    if (!first) throw new Error('MODEL_UNAVAILABLE');
    return first as Model;
  }

  async describeModel(): Promise<string> {
    const model = await this.resolveDefaultModel();
    return `${model.provider}/${model.id}`;
  }

  async completeSimple(input: ShortCallInput): Promise<string> {
    const runtime = await this.ensure();
    const model = await this.resolveCallModel(input, runtime);
    // reasoning 有意不透传：pi-ai 不传即关闭思考（openai-completions.js 的 enable_thinking = !!reasoningEffort），
    // 传 'minimal' 反而会打开。
    const options: { signal?: AbortSignal; maxTokens?: number } = { signal: input.signal };
    if (input.maxTokens !== undefined) options.maxTokens = input.maxTokens;
    const msg = await runtime.completeSimple(
      model,
      { systemPrompt: input.systemPrompt, messages: [{ role: 'user', content: input.user, timestamp: Date.now() }] },
      options,
    );
    try { input.onUsage?.({ model: `${model.provider}/${model.id}`, usage: msg.usage }); } catch { /* 记账失败不影响调用结果 */ }
    const formatted = formatNonStream(msg);
    if (!formatted.ok) throw new Error(formatted.error);
    return formatted.content;
  }

  async *streamSimple(input: ShortCallInput): AsyncGenerator<{ type: 'delta' | 'done' | 'error'; text?: string; usage?: unknown; error?: string }> {
    const runtime = await this.ensure();
    const model = await this.resolveCallModel(input, runtime);
    // 条件透传：undefined 不覆盖 provider/模型自带的采样配置，保持「不传即默认」语义。
    const options: {
      signal?: AbortSignal;
      temperature?: number;
      reasoning?: ThinkingLevel;
      samplingParams?: Record<string, unknown>;
    } = { signal: input.signal };
    if (input.temperature !== undefined) options.temperature = input.temperature;
    if (input.reasoning !== undefined) options.reasoning = input.reasoning;
    if (input.samplingParams !== undefined) options.samplingParams = input.samplingParams;
    for await (const ev of runtime.streamSimple(
      model,
      { systemPrompt: input.systemPrompt, messages: [{ role: 'user', content: input.user, timestamp: Date.now() }] },
      options,
    )) {
      if (ev.type === 'text_delta' && ev.delta) yield { type: 'delta', text: ev.delta };
      else if (ev.type === 'done') yield { type: 'done', usage: ev.message.usage };
      else if (ev.type === 'error') yield { type: 'error', usage: ev.error.usage, error: ev.error.errorMessage };
    }
  }

  private async resolveCallModel(input: ShortCallInput, runtime: ModelRuntime): Promise<Model> {
    if (input.model) return input.model;
    if (input.provider || input.modelId) {
      if (!input.provider || !input.modelId) throw new Error('模型不可用');
      const found = runtime.getModel(input.provider, input.modelId);
      if (!found) throw new Error('模型不可用');
      return found;
    }
    return this.resolveDefaultModel();
  }

  private settings(): Promise<{ provider: string; modelId: string }> {
    return this.options.resolveSettings?.() ?? Promise.resolve({ provider: '', modelId: '' });
  }
}
