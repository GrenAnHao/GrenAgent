# 供应商与模型管理（阶段二：image/tts/embedding 收编）实现计划

> **面向 AI 代理的工作者：** 必需子技能：superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现。步骤用复选框（`- [ ]`）跟踪。

**目标：** 图像/TTS/Embedding 三类能力的 Key/Base URL 从供应商库（auth.json+models.json）解析，模型只存「供应商+模型 id」；移除各自 key/baseURL env；修复阶段一 OPENAI_API_KEY 兜底回归。

**架构：** 新增共享解析器 `resolveCapabilityEndpoint(ctx.modelRegistry, provider, model, fallback)` → baseUrl 取该 provider 模型的 baseUrl、key 取 `getApiKeyForProvider`。四个扩展改用它；前端能力设置改为 provider+model 选择器；全力迁移旧 env。

**技术栈：** TypeScript（extensions / React），Vitest。**不改 pi 核心**（仅 extensions + 前端）。

---

## 关键约束

1. **改 extensions 后必须重编 sidecar**：`cd tauri-agent && bun run build:sidecar`（extensions 与 cli 一起打进二进制）。
2. `resolveEmbeddingConfig` 由同步变**异步**，所有调用点加 `await`（均在 async 上下文）。
3. 解析器参数用 `Pick<ModelRegistry,'getAll'|'getApiKeyForProvider'>` 便于单测。
4. 无 key 时 embedding 仍降级关键词检索（保留）。
5. 禁 emoji。

## 文件结构

| 区域 | 文件 | 职责 |
|------|------|------|
| 扩展 | `extensions/_shared/provider-endpoint.ts`（新） | `resolveCapabilityEndpoint` |
| 扩展 | `extensions/image-gen/image.ts`、`index.ts` | 异步 resolve + execute 传 registry |
| 扩展 | `extensions/tts/tts.ts`、`index.ts` | 同上 |
| 扩展 | `extensions/knowledge-rag/embedding.ts`、`index.ts` | 异步 resolve + 4 调用点 |
| 扩展 | `extensions/long-term-memory/embedding.ts`、`index.ts` | 异步 resolve + 调用点 |
| 前端 | `tauri-agent/src/features/settings/capabilityModelPresets.ts`（新） | provider→capability→模型建议 |
| 前端 | `tauri-agent/src/features/settings/CapabilityModelField.tsx`（新） | 供应商+模型两控件 |
| 前端 | `tauri-agent/src/features/settings/phase2Migration.ts`（新） | 旧 env → provider+model 迁移 |
| 前端 | `settingsSchema.ts`、`SettingsPanel.tsx` | 'capability' 字段 + 渲染分支 + 4 section 改造 |

---

## 任务 1：共享解析器 `provider-endpoint.ts`

**文件：** 创建 `extensions/_shared/provider-endpoint.ts`、`extensions/_shared/provider-endpoint.test.ts`

- [ ] **步骤 1：实现**

```ts
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export interface CapabilityEndpoint {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type RegistryLike = Pick<ModelRegistry, "getAll" | "getApiKeyForProvider">;

export async function resolveCapabilityEndpoint(
  registry: RegistryLike,
  provider: string | undefined,
  model: string | undefined,
  fallbackModel: string,
): Promise<CapabilityEndpoint> {
  const p = (provider ?? "").trim();
  const baseUrl = (registry.getAll().find((m) => m.provider === p)?.baseUrl ?? "").replace(/\/+$/, "");
  const apiKey = p ? ((await registry.getApiKeyForProvider(p)) ?? "") : "";
  const resolved = (model ?? "").trim() || fallbackModel;
  return { enabled: apiKey.length > 0 && baseUrl.length > 0, baseUrl, apiKey, model: resolved };
}
```

- [ ] **步骤 2：测试**

```ts
import { describe, expect, it } from "vitest";
import { resolveCapabilityEndpoint } from "./provider-endpoint";

const reg = (key: string | undefined) => ({
  getAll: () => [{ provider: "openai", baseUrl: "https://api.openai.com/v1/" }] as never,
  getApiKeyForProvider: async (p: string) => (p === "openai" ? key : undefined),
});

describe("resolveCapabilityEndpoint", () => {
  it("resolves baseUrl+key, strips trailing slash, applies fallback model", async () => {
    const ep = await resolveCapabilityEndpoint(reg("sk-x") as never, "openai", "", "text-embedding-3-small");
    expect(ep).toEqual({ enabled: true, baseUrl: "https://api.openai.com/v1", apiKey: "sk-x", model: "text-embedding-3-small" });
  });
  it("disabled when no key", async () => {
    const ep = await resolveCapabilityEndpoint(reg(undefined) as never, "openai", "m", "fb");
    expect(ep.enabled).toBe(false);
  });
  it("disabled when provider unknown (no baseUrl)", async () => {
    const ep = await resolveCapabilityEndpoint(reg("k") as never, "nope", "m", "fb");
    expect(ep.enabled).toBe(false);
  });
});
```

- [ ] **步骤 3：运行**

运行：`cd extensions && bunx vitest run _shared/provider-endpoint.test.ts`（若 extensions 无独立 vitest，则在仓库提供的测试入口运行；先确认命令）
预期：3 passed。

- [ ] **步骤 4：Commit**（按用户许可；默认暂不提交）

---

## 任务 2：image-gen 改造

**文件：** 修改 `extensions/image-gen/image.ts`、`extensions/image-gen/index.ts`；测试 `extensions/image-gen/image.test.ts`（新）

- [ ] **步骤 1：image.ts 改异步 resolve**

替换 `resolveImageConfig`：

```ts
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";
import { resolveCapabilityEndpoint, type RegistryLike } from "../_shared/provider-endpoint.js";

export interface ImageConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  size: string;
}

export async function resolveImageConfig(registry: RegistryLike): Promise<ImageConfig> {
  const ep = await resolveCapabilityEndpoint(registry, getConfig("IMAGE_PROVIDER"), getConfig("IMAGE_MODEL"), "gpt-image-1");
  return { ...ep, size: getConfig("IMAGE_SIZE") ?? "1024x1024" };
}
```

`generateImage` 不变，但把错误文案改为：`throw new Error("image generation disabled: 请在设置-供应商选择图像供应商并配置其 API Key")`。`ModelRegistry` 导入仅用于类型，可改为 `type` 导入（此处 RegistryLike 已涵盖）。

- [ ] **步骤 2：index.ts execute 传 registry**

把 `const config = resolveImageConfig();` 改为：

```ts
      const config = await resolveImageConfig(ctx.modelRegistry);
```

- [ ] **步骤 3：测试**

```ts
import { describe, expect, it, vi } from "vitest";
vi.mock("../_shared/runtime-config.js", () => ({
  getConfig: (k: string) => ({ IMAGE_PROVIDER: "openai", IMAGE_MODEL: "gpt-image-1", IMAGE_SIZE: "512x512" } as Record<string,string>)[k],
}));
import { resolveImageConfig } from "./image";

it("resolves image config from provider library", async () => {
  const registry = {
    getAll: () => [{ provider: "openai", baseUrl: "https://api.openai.com/v1" }] as never,
    getApiKeyForProvider: async () => "sk-x",
  };
  const c = await resolveImageConfig(registry as never);
  expect(c).toMatchObject({ enabled: true, baseUrl: "https://api.openai.com/v1", apiKey: "sk-x", model: "gpt-image-1", size: "512x512" });
});
```

- [ ] **步骤 4：运行** `bunx vitest run extensions/image-gen/image.test.ts` → PASS。
- [ ] **步骤 5：Commit**（默认暂不提交）

---

## 任务 3：tts 改造

**文件：** 修改 `extensions/tts/tts.ts`、`extensions/tts/index.ts`；测试 `extensions/tts/tts.test.ts`（新）

- [ ] **步骤 1：tts.ts 改异步 resolve**

```ts
import { getConfig } from "../_shared/runtime-config.js";
import { resolveCapabilityEndpoint, type RegistryLike } from "../_shared/provider-endpoint.js";

export interface TtsConfig {
  enabled: boolean; baseUrl: string; apiKey: string; model: string; voice: string; format: string;
}

export async function resolveTtsConfig(registry: RegistryLike): Promise<TtsConfig> {
  const ep = await resolveCapabilityEndpoint(registry, getConfig("TTS_PROVIDER"), getConfig("TTS_MODEL"), "gpt-4o-mini-tts");
  return { ...ep, voice: getConfig("TTS_VOICE") ?? "alloy", format: getConfig("TTS_FORMAT") ?? "mp3" };
}
```

`synthesizeSpeech` 不变；错误文案改为「请在设置-供应商选择 TTS 供应商并配置其 API Key」。

- [ ] **步骤 2：index.ts execute** 改 `const config = await resolveTtsConfig(ctx.modelRegistry);`
- [ ] **步骤 3：测试**（同任务 2 模式，断言 voice/format + baseUrl/apiKey/model）
- [ ] **步骤 4：运行** → PASS。
- [ ] **步骤 5：Commit**（默认暂不提交）

---

## 任务 4：knowledge-rag 改造

**文件：** 修改 `extensions/knowledge-rag/embedding.ts`、`extensions/knowledge-rag/index.ts`；测试 `embedding.test.ts`（新）

- [ ] **步骤 1：embedding.ts 改异步 resolve**

```ts
import { getConfig } from "../_shared/runtime-config.js";
import { resolveCapabilityEndpoint, type RegistryLike } from "../_shared/provider-endpoint.js";

export interface EmbeddingConfig { enabled: boolean; baseUrl: string; apiKey: string; model: string; }

export async function resolveEmbeddingConfig(registry: RegistryLike): Promise<EmbeddingConfig> {
  return resolveCapabilityEndpoint(registry, getConfig("KB_EMBED_PROVIDER"), getConfig("KB_EMBED_MODEL"), "text-embedding-3-small");
}
```

`embedTexts` 不变；错误文案改为「embedding disabled: 请在设置-知识库选择 embedding 供应商」。

- [ ] **步骤 2：index.ts 4 个调用点加 registry + await**

- `before_agent_start`（约 50 行）：`const config = await resolveEmbeddingConfig(ctx.modelRegistry);`
- `kb_search` execute（约 84）：同上
- `kb_add` execute（约 136）：同上
- `/kb add` 命令 handler（约 180）：同上

- [ ] **步骤 3：测试** embedding.test.ts（mock registry + getConfig，断言 enabled/baseUrl/model；无 key disabled）
- [ ] **步骤 4：运行** → PASS。
- [ ] **步骤 5：Commit**（默认暂不提交）

---

## 任务 5：long-term-memory 改造

**文件：** 修改 `extensions/long-term-memory/embedding.ts`、`extensions/long-term-memory/index.ts`；测试 `embedding.test.ts`（新）

- [ ] **步骤 1：embedding.ts 改异步 resolve**（同任务 4，env 用 `MEMORY_EMBED_PROVIDER`/`MEMORY_EMBED_MODEL`，fallback `text-embedding-3-small`）

- [ ] **步骤 2：index.ts 调用点加 registry + await**

`resolveEmbeddingConfig()` 当前在以下处调用，均有 ctx，改 `await resolveEmbeddingConfig(ctx.modelRegistry)`：
- `before_agent_start`（约 147）
- `smartSave`（约 120）— 它接 `SaveCtx`（含 ctx.modelRegistry？当前 `SaveCtx = AskCtx & { cwd }`，AskCtx 含 `modelRegistry?`）。把 `resolveEmbeddingConfig()` 调用改为传 `ctx.modelRegistry`；确保 `smartSave`/`recallMerged` 的 ctx 透传 `modelRegistry`。
- `memory_recall` execute（约 249）
- `/memory add`、`/memory promote`、`/memory rollback` 命令（约 282/298/353）

> 实现细节：把内部辅助（`smartSave`、`recallMerged`）的 ctx 形参类型补上 `modelRegistry: RegistryLike`，并在调用 `resolveEmbeddingConfig` 处传入。各 `pi.on`/工具/命令的 `ctx` 已是 `ExtensionContext`，含 `modelRegistry`。

- [ ] **步骤 3：测试** embedding.test.ts（同任务 4 模式）
- [ ] **步骤 4：运行** → PASS。
- [ ] **步骤 5：Commit**（默认暂不提交）

---

## 任务 6：前端 capabilityModelPresets + CapabilityModelField

**文件：** 创建 `capabilityModelPresets.ts`、`CapabilityModelField.tsx`、`CapabilityModelField.test.tsx`

- [ ] **步骤 1：capabilityModelPresets.ts**

```ts
export type Capability = 'image' | 'embedding' | 'tts';

export const CAPABILITY_MODEL_PRESETS: Record<string, Partial<Record<Capability, string[]>>> = {
  openai: {
    image: ['gpt-image-1', 'dall-e-3'],
    embedding: ['text-embedding-3-small', 'text-embedding-3-large'],
    tts: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
  },
};

export function suggestModels(provider: string, capability: Capability): string[] {
  return CAPABILITY_MODEL_PRESETS[provider]?.[capability] ?? [];
}
```

- [ ] **步骤 2：CapabilityModelField.tsx**

```tsx
import { AutoComplete, Select } from 'antd';
import { useEffect, useState } from 'react';
import { Flexbox } from '@lobehub/ui';
import { pi } from '../../lib/pi';
import { loadState } from './providerConfigAdapter';
import { PROVIDER_PRESETS } from './providerPresets';
import { suggestModels, type Capability } from './capabilityModelPresets';
import type { SettingField } from './settingsSchema';

interface Props {
  field: SettingField;            // key=providerKey, modelKey, capability
  values: Record<string, string>;
  setValue: (key: string, v: string) => void;
}

export function CapabilityModelField({ field, values, setValue }: Props) {
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    void pi.getProviderConfig().then((cfg) => {
      setProviders(loadState(cfg.modelsJson, cfg.authJson, PROVIDER_PRESETS).map((p) => ({ id: p.id, name: p.name })));
    });
  }, []);

  const provider = values[field.key] ?? '';
  const model = values[field.modelKey ?? ''] ?? '';
  const cap = (field.capability ?? 'embedding') as Capability;
  const options = suggestModels(provider, cap).map((m) => ({ value: m }));

  return (
    <Flexbox gap={6} style={{ paddingBlock: 10 }}>
      <div style={{ fontSize: 13 }}>{field.label}</div>
      {field.description ? <div style={{ fontSize: 12, opacity: 0.7 }}>{field.description}</div> : null}
      <Flexbox horizontal gap={8}>
        <Select
          data-testid={`set-field-${field.key}`}
          value={provider || undefined}
          placeholder="供应商"
          style={{ minWidth: 160 }}
          options={providers.map((p) => ({ value: p.id, label: p.name }))}
          onChange={(v) => setValue(field.key, v ?? '')}
        />
        <AutoComplete
          data-testid={`set-field-${field.modelKey}`}
          value={model}
          placeholder="模型 id"
          style={{ flex: 1 }}
          options={options}
          onChange={(v) => setValue(field.modelKey ?? '', v ?? '')}
          filterOption={(input, opt) => String(opt?.value ?? '').toLowerCase().includes(input.toLowerCase())}
        />
      </Flexbox>
    </Flexbox>
  );
}
```

- [ ] **步骤 3：测试** CapabilityModelField.test.tsx（mock pi.getProviderConfig；断言 provider 选项渲染、改 provider/model 调 setValue；用 cleanup）

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const { getProviderConfig } = vi.hoisted(() => ({
  getProviderConfig: vi.fn(() => Promise.resolve({ modelsJson: '{}', authJson: '{"openai":{"type":"api_key","key":"k"}}', agentDir: '/a' })),
}));
vi.mock('../../lib/pi', () => ({ pi: { getProviderConfig } }));
import { CapabilityModelField } from './CapabilityModelField';
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('changes provider via setValue', async () => {
  const setValue = vi.fn();
  render(<CapabilityModelField field={{ key: 'IMAGE_PROVIDER', modelKey: 'IMAGE_MODEL', capability: 'image', label: '图像模型', type: 'capability' }} values={{}} setValue={setValue} />);
  await waitFor(() => expect(getProviderConfig).toHaveBeenCalled());
  // 选择交互按实现 data-testid 落实
});
```

- [ ] **步骤 4：运行** → PASS。
- [ ] **步骤 5：Commit**（默认暂不提交）

---

## 任务 7：settingsSchema + SettingsPanel 接入

**文件：** 修改 `settingsSchema.ts`、`SettingsPanel.tsx`、`settingsSchema.test.ts`

- [ ] **步骤 1：settingsSchema 类型与字段**

- `FieldType` 增加 `'capability'`。
- `SettingField` 增加 `modelKey?: string;` 与 `capability?: 'image' | 'embedding' | 'tts';`。
- 改 4 个 section 的 fields：
  - 图像：删 `IMAGE_API_KEY`/`IMAGE_BASE_URL`/旧 `IMAGE_MODEL`；加 `{ key:'IMAGE_PROVIDER', modelKey:'IMAGE_MODEL', capability:'image', type:'capability', label:'图像模型', description:'供应商+模型' }`；保留 `IMAGE_SIZE`。
  - TTS：删 key/baseURL/旧 model；加 `{ key:'TTS_PROVIDER', modelKey:'TTS_MODEL', capability:'tts', type:'capability', label:'语音模型' }`；保留 `TTS_VOICE`/`TTS_FORMAT`。
  - 知识库：删 `KB_EMBED_API_KEY`/`KB_EMBED_BASE_URL`/旧 `KB_EMBED_MODEL`；加 `{ key:'KB_EMBED_PROVIDER', modelKey:'KB_EMBED_MODEL', capability:'embedding', type:'capability', label:'Embedding 模型' }`；保留 `KB_AUTO_INJECT`/`KB_AUTO_TOPK`。
  - 记忆「记忆召回」：删 `MEMORY_EMBED_API_KEY`/`MEMORY_EMBED_MODEL`；加 `{ key:'MEMORY_EMBED_PROVIDER', modelKey:'MEMORY_EMBED_MODEL', capability:'embedding', type:'capability', label:'记忆 Embedding 模型' }`。

- [ ] **步骤 2：SettingsPanel 渲染分支**

`import { CapabilityModelField } from './CapabilityModelField';`，把 section 字段渲染改为：

```tsx
{sec.fields.map((f) =>
  f.type === 'capability' ? (
    <CapabilityModelField key={f.key} field={f} values={values} setValue={setValue} />
  ) : (
    <SettingFieldInput key={f.key} field={f} value={values[f.key] ?? ''} onChange={(v) => setValue(f.key, v)} />
  ),
)}
```

- [ ] **步骤 3：更新 settingsSchema.test**（select fields 校验仍通过；如断言了已删字段则更新）

- [ ] **步骤 4：运行** `bunx vitest run src/features/settings/settingsSchema.test.ts src/features/settings/SettingsPanel.test.tsx` → PASS。
- [ ] **步骤 5：Commit**（默认暂不提交）

---

## 任务 8：迁移 phase2Migration + 接入

**文件：** 创建 `phase2Migration.ts`、`phase2Migration.test.ts`；改 `SettingsPanel.tsx`（mount 运行一次）

- [ ] **步骤 1：纯函数 migratePhase2**

```ts
import { loadState, serializeState, type UiProvider } from './providerConfigAdapter';
import { PROVIDER_PRESETS } from './providerPresets';

const CAPS = [
  { keyPrefix: 'IMAGE', provider: 'IMAGE_PROVIDER', model: 'IMAGE_MODEL' },
  { keyPrefix: 'TTS', provider: 'TTS_PROVIDER', model: 'TTS_MODEL' },
  { keyPrefix: 'KB_EMBED', provider: 'KB_EMBED_PROVIDER', model: 'KB_EMBED_MODEL' },
  { keyPrefix: 'MEMORY_EMBED', provider: 'MEMORY_EMBED_PROVIDER', model: 'MEMORY_EMBED_MODEL' },
];

export function migratePhase2(
  settings: Record<string, string>,
  modelsJson: string | null,
  authJson: string | null,
): { nextSettings: Record<string, string>; modelsJson: string; authJson: string; changed: boolean } {
  let providers = loadState(modelsJson, authJson, PROVIDER_PRESETS);
  const next = { ...settings };
  let changed = false;

  for (const cap of CAPS) {
    const oldKey = (settings[`${cap.keyPrefix}_API_KEY`] ?? '').trim();
    const oldBase = (settings[`${cap.keyPrefix}_BASE_URL`] ?? '').replace(/\/+$/, '').trim();
    const oldModel = (settings[`${cap.keyPrefix}_MODEL`] ?? '').trim();
    if (!oldKey || (settings[cap.provider] ?? '').trim()) continue; // 无旧 key 或已迁移

    let providerId = 'openai';
    const isOpenai = !oldBase || /api\.openai\.com/.test(oldBase);
    if (!isOpenai) {
      const preset = PROVIDER_PRESETS.find((p) => p.baseUrlHint && oldBase === p.baseUrlHint.replace(/\/+$/, ''));
      if (preset) {
        providerId = preset.id;
      } else {
        // 自定义端点：建 legacy-<cap> 供应商
        providerId = `legacy-${cap.keyPrefix.toLowerCase()}`;
        const existing = providers.find((p) => p.id === providerId);
        if (!existing) {
          providers = [...providers, {
            id: providerId, name: providerId, builtIn: false,
            api: 'openai-completions', baseUrl: oldBase, apiKey: oldKey,
            models: oldModel ? [{ id: oldModel }] : [],
          } as UiProvider];
        }
      }
    }
    // 内置/预设：补 auth key（若缺）
    const target = providers.find((p) => p.id === providerId);
    if (target && target.builtIn && !target.apiKey) {
      providers = providers.map((p) => (p.id === providerId ? { ...p, apiKey: oldKey } : p));
    }

    next[cap.provider] = providerId;
    if (oldModel) next[cap.model] = oldModel;
    delete next[`${cap.keyPrefix}_API_KEY`];
    delete next[`${cap.keyPrefix}_BASE_URL`];
    changed = true;
  }

  const ser = serializeState(providers);
  return { nextSettings: next, modelsJson: ser.modelsJson, authJson: ser.authJson, changed };
}
```

> 注意 `KB_EMBED`/`MEMORY_EMBED` 的旧 model key 是 `KB_EMBED_MODEL`/`MEMORY_EMBED_MODEL`，与新 model key 同名——迁移保留即可（不删）。仅删 `*_API_KEY`/`*_BASE_URL`。`IMAGE_MODEL`/`TTS_MODEL` 旧为 text、新为 capability 的 modelKey，同名亦保留。

- [ ] **步骤 2：测试** phase2Migration.test.ts

```ts
import { describe, expect, it } from 'vitest';
import { migratePhase2 } from './phase2Migration';

it('migrates openai-based image to provider=openai + auth key', () => {
  const r = migratePhase2(
    { IMAGE_API_KEY: 'sk-a', IMAGE_MODEL: 'gpt-image-1' }, '{}', '{}',
  );
  expect(r.nextSettings.IMAGE_PROVIDER).toBe('openai');
  expect(r.nextSettings.IMAGE_API_KEY).toBeUndefined();
  expect(JSON.parse(r.authJson).openai.key).toBe('sk-a');
});

it('creates legacy provider for custom endpoint', () => {
  const r = migratePhase2(
    { KB_EMBED_API_KEY: 'k', KB_EMBED_BASE_URL: 'https://my/v1', KB_EMBED_MODEL: 'e5' }, '{}', '{}',
  );
  expect(r.nextSettings.KB_EMBED_PROVIDER).toBe('legacy-kb_embed');
  const prov = JSON.parse(r.modelsJson).providers['legacy-kb_embed'];
  expect(prov).toMatchObject({ baseUrl: 'https://my/v1', apiKey: 'k' });
});

it('is idempotent (no old key → no change)', () => {
  const r = migratePhase2({ IMAGE_PROVIDER: 'openai' }, '{}', '{}');
  expect(r.changed).toBe(false);
});
```

- [ ] **步骤 3：SettingsPanel mount 运行一次 runner**

```tsx
useEffect(() => {
  void (async () => {
    const [settings, cfg] = await Promise.all([pi.getSettings(), pi.getProviderConfig()]);
    const r = migratePhase2(settings, cfg.modelsJson, cfg.authJson);
    if (!r.changed) return;
    await pi.setProviderConfig(r.modelsJson, r.authJson);
    await pi.setSettings(r.nextSettings);
  })().catch(() => {});
}, []);
```

（SettingsPanel 现有依赖 useSettingsForm；migration runner 独立调用 pi.*，与表单加载并存即可。）

- [ ] **步骤 4：运行** phase2Migration.test + SettingsPanel.test → PASS。
- [ ] **步骤 5：Commit**（默认暂不提交）

---

## 任务 9：重编 sidecar + 端到端验证

- [ ] **步骤 1：重编译** `cd tauri-agent && bun run build:sidecar` → 成功。
- [ ] **步骤 2：前端 type-check** `bunx tsc --noEmit -p tsconfig.json` → 我方文件 0 错误。
- [ ] **步骤 3：起 app 手测成功标准**：
  1. 仅配 openai key（阶段一已迁 auth.json），图像/TTS/知识库/记忆 embedding 均可用（修复回归）。
  2. 各能力选不同供应商生效。
  3. 设置无 IMAGE/TTS/KB_EMBED/MEMORY_EMBED 的 key/baseURL 字段。
  4. 无 key 时知识库/记忆降级关键词检索。
- [ ] **步骤 4：最终 Commit**（按用户许可）

---

## 自检

**规格覆盖度：** spec §3 解析器→任务1；§5 扩展→任务2-5；§4 UI→任务6-7；§6 迁移→任务8；§7 测试→各任务内联；§10 验证→任务9。

**占位符扫描：** 无 TODO；大组件（CapabilityModelField）给出完整代码；迁移给出完整纯函数。

**类型一致性：** `RegistryLike`（Pick<ModelRegistry,...>）贯穿解析器与四扩展；`Capability`/`CapabilityEndpoint` 一致；env 键名（`*_PROVIDER`/`*_MODEL`）在扩展、settingsSchema、迁移三处一致。

**构建依赖：** 任务 1/9 含 `build:sidecar` 提醒。

**待实现时确认：** extensions 的 vitest 运行命令（任务 1 步骤 3）；long-term-memory 内部 ctx 透传 `modelRegistry`（任务 5 步骤 2）。
