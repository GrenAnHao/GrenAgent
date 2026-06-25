// 一次性子命令 `probe-models`：列出 ModelRegistry 解析后的模型（不起 RPC 运行时、不要 workspace）。
// 供桌面在"未打开项目 / 冷启动 / 真对话模式"下枚举模型用。
//
// collectModels 是纯逻辑（无 pi 依赖，便于单测）；runModelProbe 动态 import pi，仅在实际运行子命令时加载。

export interface ModelRow {
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

type RawModel = Partial<ModelRow> & { provider: string; id: string };

/** ModelRegistry 的最小契约：getAll() 返回内置 + 自定义全部模型。 */
export interface RegistryLike {
  getAll: () => RawModel[];
}

export function collectModels(registry: RegistryLike): ModelRow[] {
  return registry.getAll().map((m) => ({
    provider: m.provider,
    id: m.id,
    name: m.name ?? m.id,
    contextWindow: m.contextWindow ?? 0,
    maxTokens: m.maxTokens ?? 0,
    reasoning: m.reasoning ?? false,
    input: m.input ?? ["text"],
    cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
}

export async function runModelProbe(): Promise<void> {
  try {
    const { AuthStorage, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
    const registry = ModelRegistry.create(AuthStorage.create()) as unknown as RegistryLike;
    process.stdout.write(`${JSON.stringify({ ok: true, models: collectModels(registry) })}\n`);
  } catch (e) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, models: [], error: e instanceof Error ? e.message : String(e) })}\n`,
    );
  }
}
