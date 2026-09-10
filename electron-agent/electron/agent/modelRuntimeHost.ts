import type { ModelRuntime } from '../../../cli/src/pi-sdk.js';

export interface ModelRuntimeHostOptions {
  /** 注入点仅为可测性；生产传 () => ModelRuntime.create({ authPath, modelsPath })。 */
  create: () => Promise<ModelRuntime>;
}

/**
 * 进程内唯一的 ModelRuntime。今日每个 sidecar 各持一份；进程内嵌后鉴权与模型表只需一份，
 * 由各 WorkspaceHandle 共用（第 3 份再加 completeSimple / resolveDefaultModel）。
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
}
