import type { ModelRuntime } from '../../../cli/src/pi-sdk.js';
import { formatNonStream } from '../../../extensions/_shared/oneshot.js';

type Model = NonNullable<ReturnType<ModelRuntime['getModel']>>;

export interface ShortCallInput {
  user: string;
  systemPrompt?: string;
  model?: Model;
  provider?: string;
  modelId?: string;
  signal?: AbortSignal;
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
    const msg = await runtime.completeSimple(
      model,
      { systemPrompt: input.systemPrompt, messages: [{ role: 'user', content: input.user, timestamp: Date.now() }] },
      { signal: input.signal },
    );
    const formatted = formatNonStream(msg);
    if (!formatted.ok) throw new Error(formatted.error);
    return formatted.content;
  }

  async *streamSimple(input: ShortCallInput): AsyncGenerator<{ type: 'delta' | 'done' | 'error'; text?: string; usage?: unknown; error?: string }> {
    const runtime = await this.ensure();
    const model = await this.resolveCallModel(input, runtime);
    for await (const ev of runtime.streamSimple(
      model,
      { systemPrompt: input.systemPrompt, messages: [{ role: 'user', content: input.user, timestamp: Date.now() }] },
      { signal: input.signal },
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
