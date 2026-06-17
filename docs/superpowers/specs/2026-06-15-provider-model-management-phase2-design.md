# 供应商与模型管理（阶段二：image/tts/embedding 收编）设计

- 日期：2026-06-15
- 状态：设计待审（brainstorming 产出，已据代码核对）
- 主题：让图像/TTS/Embedding 三类能力的 Key/Base URL/模型统一从供应商库取，移除各自独立 env
- 前置：阶段一（供应商管理中心）已实现并通过测试
- 关联：`extensions/image-gen/`、`extensions/tts/`、`extensions/knowledge-rag/`、`extensions/long-term-memory/`、`extensions/_shared/`、`pi/packages/coding-agent/src/core/extensions/types.ts`、`pi/packages/coding-agent/src/core/model-registry.ts`、`tauri-agent/src/features/settings/`

## 1. 目标与范围

### 1.1 目标

阶段一把对话/标题/子代理/记忆 LLM 统一到供应商库。阶段二把剩下的**直连端点能力**也收编：image-gen、tts、knowledge-rag（embedding）、long-term-memory（embedding）。它们的 Key/Base URL 不再各配，而是从供应商库（`auth.json` + `models.json`）解析，模型只存「供应商 + 模型 id」。

### 1.2 范围（已确认全收编）

| 能力 | 扩展 | 端点 | 现状 env | 新设置 |
|------|------|------|----------|--------|
| 图像 | `image-gen` | `/images/generations` | IMAGE_API_KEY/BASE_URL/MODEL/SIZE | IMAGE_PROVIDER + IMAGE_MODEL + IMAGE_SIZE |
| 语音 | `tts` | `/audio/speech` | TTS_API_KEY/BASE_URL/MODEL/VOICE/FORMAT | TTS_PROVIDER + TTS_MODEL + TTS_VOICE + TTS_FORMAT |
| 知识库 | `knowledge-rag` | `/embeddings` | KB_EMBED_API_KEY/BASE_URL/MODEL | KB_EMBED_PROVIDER + KB_EMBED_MODEL |
| 记忆 | `long-term-memory` | `/embeddings` | MEMORY_EMBED_API_KEY/BASE_URL/MODEL | MEMORY_EMBED_PROVIDER + MEMORY_EMBED_MODEL |

### 1.3 成功标准

1. 选某供应商后，三类能力用该供应商 Key+Base URL 工作，无需单独配 Key。
2. 设置里不再有 IMAGE/TTS/KB_EMBED/MEMORY_EMBED 的 key/baseURL 字段。
3. 仅配 openai key（阶段一迁移后存于 auth.json）即可让三类能力工作（**修复阶段一回归**）。
4. 无 key 时 embedding 仍降级关键词检索（保留现有兜底）。

### 1.4 阶段一回归说明

阶段一把全局 `OPENAI_API_KEY` 从 `runtime-settings.json` 迁到 `auth.json`。而这四个扩展原先靠 `getConfig("OPENAI_API_KEY")`（读 runtime-settings）兜底——迁移后该兜底为空，三类能力的默认 key 失效。阶段二从供应商库（auth.json）取 key 正好修复此回归。

## 2. 背景（已核对代码）

- 四个扩展均 `getConfig()` 读 env + 裸 `fetch` OpenAI 兼容端点（`resolveImageConfig`/`resolveTtsConfig`/`resolveEmbeddingConfig`，同步）。
- `ExtensionContext`（`core/extensions/types.ts:300`）对所有工具/事件/命令暴露**完整** `modelRegistry: ModelRegistry` 与 `model`（`runner.ts:641` getter 返回真实实例）。
- `ModelRegistry`：`getAll(): Model[]`（每个 Model 含 `provider`、`baseUrl`）、`getApiKeyForProvider(provider): Promise<string|undefined>`（读 auth.json + models.json）、`find`、`getApiKeyAndHeaders`。
- pi-ai 无 TTS/embedding 抽象（image 有 native API），故保留裸 fetch，三类一致。
- 先例：`long-term-memory` 已用 `ctx.modelRegistry.find()` 解析对话模型（`llm.ts`/`index.ts:101`）。

## 3. 架构与解析

### 3.1 共享解析器（新 `extensions/_shared/provider-endpoint.ts`）

```ts
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export interface CapabilityEndpoint {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}

type RegistryLike = Pick<ModelRegistry, "getAll" | "getApiKeyForProvider">;

/** 从供应商库解析某能力端点：baseUrl 取该 provider 任一模型的 baseUrl，key 取 getApiKeyForProvider。 */
export async function resolveCapabilityEndpoint(
  registry: RegistryLike,
  provider: string | undefined,
  model: string | undefined,
  fallbackModel: string,
): Promise<CapabilityEndpoint> {
  const p = (provider ?? "").trim();
  const baseUrl =
    (registry.getAll().find((m) => m.provider === p)?.baseUrl ?? "").replace(/\/+$/, "");
  const apiKey = p ? ((await registry.getApiKeyForProvider(p)) ?? "") : "";
  const resolved = (model ?? "").trim() || fallbackModel;
  return { enabled: apiKey.length > 0 && baseUrl.length > 0, baseUrl, apiKey, model: resolved };
}
```

要点：
- baseUrl 复用 pi 内置/自定义模型的 baseUrl，**不维护重复默认表**。
- key 经 `getApiKeyForProvider`（auth.json 优先），修复阶段一回归。
- `enabled=false`（无 key/baseUrl）时，embedding 走关键词兜底，image/tts 抛清晰错误。

### 3.2 设置字段（provider + model）

各能力存两个 env：`*_PROVIDER`（供应商 id）、`*_MODEL`（模型 id）；行为字段（IMAGE_SIZE / TTS_VOICE / TTS_FORMAT）保留。移除 `*_API_KEY` / `*_BASE_URL`。

## 4. 设置 UI

### 4.1 CapabilityModelField（新 `tauri-agent/src/features/settings/CapabilityModelField.tsx`）

一行两控件：
- 供应商下拉：选项来自供应商库（`pi.getProviderConfig()` + `PROVIDER_PRESETS`），值为 provider id。
- 模型下拉：antd `AutoComplete`，建议来自 `capabilityModelPresets[provider]?.[capability]`，允许手填。

Props：`{ providerKey, modelKey, capability, values, onChange }`；通过 `onChange(key, value)` 分别写 `*_PROVIDER` / `*_MODEL`。

### 4.2 capabilityModelPresets（新 `tauri-agent/src/features/settings/capabilityModelPresets.ts`）

```ts
export type Capability = 'image' | 'embedding' | 'tts';
export const CAPABILITY_MODEL_PRESETS: Record<string, Partial<Record<Capability, string[]>>> = {
  openai: {
    image: ['gpt-image-1', 'dall-e-3'],
    embedding: ['text-embedding-3-small', 'text-embedding-3-large'],
    tts: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
  },
  // 其余供应商按需补充；未列出的 provider 仅靠手填
};
```

### 4.3 settingsSchema 改造

- `FieldType` 增加 `'capability'`；`SettingField` 增加 `modelKey?: string`、`capability?: Capability`。
- 图像 section：一个 capability 字段（`IMAGE_PROVIDER`+`IMAGE_MODEL`）+ 保留 `IMAGE_SIZE`；移除 `IMAGE_API_KEY`/`IMAGE_BASE_URL`/旧 `IMAGE_MODEL`(text)。
- TTS：capability（`TTS_PROVIDER`+`TTS_MODEL`）+ 保留 `TTS_VOICE`/`TTS_FORMAT`；移除 key/baseURL/旧 model。
- 知识库：capability（`KB_EMBED_PROVIDER`+`KB_EMBED_MODEL`）+ 保留 `KB_AUTO_INJECT`/`KB_AUTO_TOPK`；移除 key/baseURL/旧 model。
- 记忆：把「记忆召回」里的 `MEMORY_EMBED_API_KEY`/`MEMORY_EMBED_MODEL` 换成 capability（`MEMORY_EMBED_PROVIDER`+`MEMORY_EMBED_MODEL`）。

### 4.4 渲染

`SettingFieldInput` 对 `type === 'capability'` 渲染 `CapabilityModelField`；其余字段走原逻辑，仍在各 section 的 `SettingCard` 内（不特判整面板）。

## 5. 扩展改造

共同模式：`resolveXxxConfig()`（同步读 env）→ `await resolveCapabilityEndpoint(ctx.modelRegistry, PROVIDER, MODEL, fallback)`；行为字段仍 `getConfig`；端点路径不变。解析器参数类型 `Pick<ModelRegistry,'getAll'|'getApiKeyForProvider'>`（便于单测）。

| 扩展 | 文件 | fallback 模型 | 备注 |
|------|------|---------------|------|
| image-gen | `image.ts`、`index.ts` | `gpt-image-1` | execute 有 ctx，传 `ctx.modelRegistry`；size 保留 |
| tts | `tts.ts`、`index.ts` | `gpt-4o-mini-tts` | voice/format 保留 |
| knowledge-rag | `embedding.ts` + 调用点 | `text-embedding-3-small` | `resolveEmbeddingConfig` 改异步；无 key 仍降级关键词 |
| long-term-memory | `embedding.ts`、`index.ts` | `text-embedding-3-small` | 各调用点（before_agent_start/agent_end/工具/`/memory`）均有 ctx |

> 实现时先 Read 每个 `index.ts` 的 embedding 调用点，把 `ctx.modelRegistry` 线程化到 `resolveEmbeddingConfig` 调用处；`resolveEmbeddingConfig` 由同步变异步会让若干调用点跟随 `await`（多数已是 async 上下文）。

## 6. 迁移（全力迁移，已确认）

一次性、幂等。对每个能力（image/tts/kb/memory）若旧 `*_API_KEY` 非空且新 `*_PROVIDER` 未设：

1. 规整旧 baseURL（去尾斜杠）。
2. 解析目标供应商：
   - 空 或 `https://api.openai.com/v1` → `openai`；
   - 命中某预设 `baseUrlHint` → 该预设 id；
   - 否则（自定义端点）→ 新建自定义供应商 `legacy-<capability>`（`{ name, api:'openai-completions', baseUrl: 旧base, apiKey: 旧key, models:[{id: 旧model}] }`）并指向它。
3. 对内置/预设目标：若 auth.json 缺该 provider 的 key 且旧 key 非空 → 写入 auth.json。
4. 设 `*_PROVIDER`、`*_MODEL`（旧 model 或默认），删除旧 `*_API_KEY`/`*_BASE_URL`/旧 `*_MODEL`(text)。
5. 通过 `pi.setProviderConfig` 落库 + `pi.setSettings` 写回设置。

迁移逻辑实现为前端纯函数 `migratePhase2(settings, providerLibrary) → { nextSettings, nextProviders, changed }` + 一个 runner（调 setProviderConfig/setSettings），便于单测；放在 ProvidersSettings 或设置加载处运行一次。

## 7. 测试

| 层 | 内容 |
|----|------|
| 扩展 | `_shared/provider-endpoint.test.ts`（mock registry：有/无 key、baseUrl 取值、fallback model、enabled） |
| 扩展 | 各 `resolveXxxConfig` 单测（mock registry）：返回 baseUrl/key/model；无 key disabled |
| 前端 | `CapabilityModelField` 渲染 + provider/model 变更回调；`capabilityModelPresets` |
| 前端 | `migratePhase2` 纯函数单测（openai 默认 / 预设命中 / 自定义端点建供应商 / 幂等） |
| 前端 | `settingsSchema.test` 随字段变更更新 |

## 8. 风险与缓解

| 风险 | 缓解 |
|------|------|
| `resolveEmbeddingConfig` 由同步变异步，调用点漏改 | 实现时逐一 Read `index.ts` 调用点；type-check 兜底 |
| provider 无任何模型 → baseUrl 解析为空 | 内置 provider 必有内置模型；自定义 provider schema 要求 models；迁移为自定义端点建带 model 的供应商 |
| 迁移把自定义端点 key 写错位置 | 自定义端点统一建 `legacy-<capability>` 自定义供应商（key 入 models.json.apiKey），不污染内置 auth |
| 改 extensions 后需重编 sidecar | 复用阶段一结论：`bun run build:sidecar`（extensions 打进 sidecar 同一构建） |
| AutoComplete 自由输入与建议混用 | 用 antd `AutoComplete`（options 为建议、允许任意输入）；保留当前值 |

## 9. 实现文件清单

| 区域 | 文件 |
|------|------|
| 扩展（改后须 `build:sidecar`） | `extensions/_shared/provider-endpoint.ts`（新）、`extensions/image-gen/image.ts`+`index.ts`、`extensions/tts/tts.ts`+`index.ts`、`extensions/knowledge-rag/embedding.ts`+调用点、`extensions/long-term-memory/embedding.ts`+`index.ts` |
| 前端 | `features/settings/CapabilityModelField.tsx`（新）、`capabilityModelPresets.ts`（新）、`phase2Migration.ts`（新）、`settingsSchema.ts`、`SettingField.tsx` |
| 测试 | 上述对应 `*.test.ts(x)` |

## 10. 验证

1. `bun run build:sidecar` 重编译（含 extensions 改动）。
2. `tauri dev` 手测成功标准 1-4。
3. 扩展/前端单测通过；type-check 干净。

---

**规格自检（2026-06-15）**

- [x] 无占位符/TODO
- [x] 决策（registry 解析 / provider+model dropdown / 全收编 / 全力迁移）一致落入 3/4/5/6 节
- [x] 与阶段一不冲突（复用 auth.json/models.json + build:sidecar）
- [x] 范围可单一实现计划覆盖
- [x] 关键 API（ExtensionContext.modelRegistry、getAll/getApiKeyForProvider）已实地核验
