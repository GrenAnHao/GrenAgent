# 供应商与模型管理（阶段一）设计

- 日期：2026-06-15
- 状态：已实现（阶段一）；热重载机制经第四轮实地核验后改为 switch_session 重建（见下方 errata）
- 主题：在设置中增加供应商管理中心，对齐 Pi `ModelRegistry` / `models.json` / `auth.json`，保存即时生效
- 关联：`pi/packages/coding-agent/src/core/model-registry.ts`、`pi/packages/coding-agent/src/core/auth-storage.ts`、`tauri-agent/src-tauri/src/commands/providers.rs`、`tauri-agent/scripts/build-sidecar.mjs`、`tauri-agent/src/features/settings/`

> **重大修订（2026-06-15，第四轮 · 实地核验构建链路）**
> sidecar 实际由 `tauri-agent/scripts/build-sidecar.mjs` 编译 `cli/src/main.ts`，其 pi 运行时 **import 自 npm 包 `@earendil-works/pi-coding-agent@0.78.x`**（不是本地 `pi/` fork），扩展才来自本地 `extensions/`。因此「在本地 pi fork 加 `refresh_model_registry` RPC」**不会进 sidecar**（已核 npm 包 dist 无该命令）。
> **实际实现的热重载**：`set_provider_config` 写盘后，Tauri 对每个已开 workspace 发 `get_state` 取 `sessionFile`，再 `switch_session` 到同一会话 → cli `createRuntime` 重建 `ModelRegistry` + `AuthStorage`（重新读 models.json/auth.json），会话历史保留。无需改 pi 核心、无需 fork。下文 §6.1 的「pi fork RPC」内容作废，以本 errata 为准。

## 1. 目标与范围

### 1.1 总体目标

在 tauri-agent 设置中提供**完整供应商管理中心**：内置主流供应商预设 + 自定义供应商；每个供应商配置 API Key / Base URL / 模型列表（增删改）；对话与各 chat 类功能共用同一模型来源；保存后**无需重启 sidecar** 即可生效。

### 1.2 阶段划分（已确认「分两段式」）

| 阶段 | 范围 | 不在范围内 |
|------|------|------------|
| **阶段一（本次）** | 供应商 UI + `models.json`/`auth.json` 读写 + Pi RPC 热重载；chat 类统一（对话 / 标题 / 子代理 / 记忆 LLM）；移除 `OPENAI_API_KEY` 重复配置 | image / tts / embedding 收编 |
| **阶段二（后续）** | 模型增加 `kind`（chat / image / embedding / tts）；改造 `image-gen` / `tts` / `knowledge-rag` / `long-term-memory`；移除 IMAGE/TTS/KB_EMBED/MEMORY_EMBED 独立 env | — |

### 1.3 成功标准（阶段一）

1. 可在 UI 为 ≥3 个内置供应商填写 Key，对话模型下拉立即可选对应模型。
2. 可新增自定义 OpenAI 兼容供应商及模型，保存后 sidecar 不重启即可出现在 `getAvailableModels`。
3. `titleModel` / `SUBAGENT_MODEL` / `MEMORY_MODEL` 与对话共用同一模型列表。
4. 设置「通用与模型」中不再出现 `OPENAI_API_KEY`。

## 2. 背景

### 2.1 现状

- **Pi 核心**：自定义供应商/模型持久化在 `~/.pi/agent/models.json`，由 `ModelRegistry` 加载；API Key 还可存 `~/.pi/agent/auth.json`（裸 `Record<provider, { type: "api_key", key } | OAuth>`）。
- **AuthStorage 有内存缓存**：凭据缓存于 `this.data`，`reload()` 重新读盘（构造时即调一次，`auth-storage.ts:208`）。**直接改 auth.json 文件后不 reload，pi 进程读不到新 Key。**
- **`get_available_models` 只回已配 auth 的模型**：RPC handler `await session.modelRegistry.getAvailable()`（= `this.models.filter(hasConfiguredAuth)`，同步），响应 `{ models }` 为**完整 `Model[]`**（含 cost/maxTokens/input/contextWindow 等）。未配 Key 的模型不出现。
- **前端设置**：声明式 `settingsSchema.ts` + `SettingsPanel`；「通用与模型」仅 `OPENAI_API_KEY` + `titleModel`；各能力（图像/TTS/知识库/记忆 embedding）各自独立 env。
- **模型选择**：`ModelSelectField` → `pi.getAvailableModels(workspace)` → sidecar RPC `get_available_models`。
- **设置落盘**：`get_settings` / `set_settings` → `runtime-settings.json`（扁平 env），扩展 `fs.watch` 热更新。
- **缺口**：Tauri 无 `models.json` / `auth.json` 读写；无 `AuthStorage.reload()` + `ModelRegistry.refresh()` 触发通道。

### 2.2 chat 类 vs 直连端点

| 类型 | 配置方式 | 阶段一处理 |
|------|----------|------------|
| 对话 / 标题 / 子代理 / 记忆 LLM | `provider/id` → ModelRegistry | 统一从供应商库选 |
| 图像 / TTS / Embedding | 各自 `*_API_KEY` + `fetch` 专用端点 | **保留**现有 settings 字段，阶段二收编 |

### 2.3 RPC 与 sidecar 构建链路（已核对代码）

- **RPC 命令分发**：`modes/rpc/rpc-mode.ts` 的 `runRpcMode(runtimeHost)` 内一个大 `switch (command.type)`；命令/响应类型联合在 `modes/rpc/rpc-types.ts`（`RpcCommand` / `RpcResponse`）。响应统一 `{ type:"response", id, command, success, data|error }`。
- **handler 可访问范围**：同时持有 `runtimeHost`（`AgentSessionRuntime`）与 `session`；`session.modelRegistry` **公开可用**（`set_model` / `get_available_models` 即用它）。故 refresh 逻辑可**直接写在新 `case` 内，无需新增 session 方法**。
- **registry/auth 入口**：`ModelRegistry`（`core/model-registry.ts`）暴露 `readonly authStorage`、`refresh()`、`getAvailable()`、`getAll()`、`getError()`；经 `session.modelRegistry.authStorage` 可达 `AuthStorage`。
- **`ModelRegistry.refresh()` 不重载 auth**：`refresh()`（`model-registry.ts:432`）只 `resetApiProviders/resetOAuthProviders + loadModels + 重应用 registeredProviders`，**不调 `authStorage.reload()`**。
- **sidecar = 编译产物**：`build:sidecar`（`scripts/build-sidecar.mjs`）用 bun 把 `cli.ts` 编译为 `src-tauri/binaries/pi-<triple>`。**改 pi 源后必须 `bun run build:sidecar` 才进运行时。**

## 3. 方案对比（brainstorming）

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| **A（推荐）** | 前端内置供应商目录 + Tauri 直读写 Pi 标准文件 + RPC refresh | 与 Pi CLI 兼容；单源真相；实现清晰 | 需在 pi fork 加 RPC |
| B | App 自有 JSON/SQLite，导出到 models.json | UI 元数据灵活 | 双格式同步、与 CLI 漂移 |
| C | 保存后 restart sidecar | 不改 pi 核心 | 打断生成、体验差 |

**决策**：采用方案 A；生效机制采用 RPC `refresh_model_registry`（用户已确认，非 restart）。

## 4. 架构与数据

### 4.1 数据流

```
ProvidersSettings (React)
  → pi.setProviderConfig(config)
  → Tauri: 原子写 models.json + auth.json
  → Tauri: 对所有已开 workspace 发 refresh_model_registry RPC
  → Pi handler（rpc-mode.ts 新 case）:
        session.modelRegistry.authStorage.reload()  +  session.modelRegistry.refresh()   // reload 必须先于 refresh
  → getAvailableModels / ModelSelectField 立即更新
```

> 注：上面链路要生效，前提是 pi 源已重新 `bun run build:sidecar` 进二进制；仅改 `pi/` 源不重编译不会生效。

### 4.2 持久化规则

- **内置供应商 API Key** → `auth.json`（provider id 为 key）。
- **自定义供应商** → `models.json` 的 `providers.<id>`（含 `apiKey`、`baseUrl`、`api`、`models[]`）。
- **内置供应商 override**（Base URL / compat / 追加模型）→ `models.json` 对应 provider 段（可仅 `baseUrl` + `models`，无 apiKey）。
- **不**在 `runtime-settings.json` 存 provider 相关 key（阶段一移除 `OPENAI_API_KEY`）。

### 4.3 内置供应商目录（前端静态）

首期预设（可扩展）：`openai`、`anthropic`、`google`、`deepseek`、`groq`、`openrouter`、`xai`、`moonshotai`、`zai`、`minimax`、`xiaomi` 等。

每项含：displayName、默认 api 类型、说明文案；模型列表从 Pi 内置 registry 只读展示，用户可追加自定义模型到该 provider。

### 4.4 前端适配层

新增 `providerConfigAdapter.ts`：

- `loadState(modelsJson, authJson, presets)` → UI 状态（供应商列表 + 详情 + 模型表）。
- `serializeState(uiState)` → `{ modelsJson, authJson }` 符合 Pi schema。
- 内置 provider 的「已配置」判定：`auth.json` 有 key，或 env 已设（只读提示），或 models.json 有 override。

## 5. UI / 交互

### 5.1 入口

- `settingsSchema.ts` 新增分类：`id: 'providers'`，`title: '供应商'`，`group: '核心'`。
- `SettingsPanel` 对 `activeId === 'providers'` 特判渲染 `ProvidersSettings`（同 `appearance`）。

### 5.2 布局

- **左栏**（~220px）：供应商列表，分「内置 / 自定义」；状态标签（已配置 / 未配置 / 配置错误）。
- **右栏**：当前供应商详情 + 模型列表 + 操作区。
- **顶栏**：「保存」按钮（显式保存，非逐字段防抖）。

### 5.3 内置供应商详情

- API Key（password → auth.json）
- Base URL 覆盖（可选 → models.json）
- 模型区：上半只读内置模型；下半用户添加的自定义模型（可编辑/删除）
- 「添加模型」→ `createModal`

### 5.4 自定义供应商详情

- 名称、Provider ID、API 类型（`openai-completions` / `anthropic-messages` / `openai-responses` 等）
- API Key、Base URL（必填）
- 模型 CRUD
- 「删除供应商」→ `confirmModal`

### 5.5 添加/编辑模型弹窗

字段：模型 ID、显示名、推理能力、contextWindow、maxTokens；自定义 provider 可选 input（text/image）。

校验：ID 非空；数值 > 0；保存前合并进父 state，点顶栏「保存」一并落盘。

### 5.6 阶段一 settings 清理

- 从 `general.fields` 移除 `OPENAI_API_KEY`。
- 保留 `titleModel`（`type: 'model'`）、`SUBAGENT_MODEL`、`MEMORY_MODEL`。
- 保留图像 / TTS / 知识库 / 记忆 embedding 各 section（阶段二再收编）。

## 6. 后端：Tauri 命令与 Pi RPC

### 6.1 Pi fork

改动落点：两个文件，均在 `pi/packages/coding-agent/src/modes/rpc/`（**沿用 spec 原始方向，实地核验为 `modes/rpc/` 下的 `rpc-mode.ts` switch + `rpc-types.ts` 类型**）。

1. **`rpc-types.ts`**：`RpcCommand` 联合加一项，并给 `RpcResponse` 加成功变体

```ts
// RpcCommand 联合追加：
| { id?: string; type: "refresh_model_registry" }

// RpcResponse 联合追加：
| { id?: string; type: "response"; command: "refresh_model_registry"; success: true; data: { modelCount: number; error: string | null } }
```

2. **`rpc-mode.ts`** 的 `switch (command.type)` 加 case（与 `get_available_models` 同区）

```ts
case "refresh_model_registry": {
  session.modelRegistry.authStorage.reload();   // 1) 先清 auth 缓存，否则新写入的 Key 读不到
  session.modelRegistry.refresh();              // 2) 再重读 models.json
  const models = await session.modelRegistry.getAvailable();
  return success(id, "refresh_model_registry", {
    modelCount: models.length,
    error: session.modelRegistry.getError() ?? null,
  });
}
```

RPC 命令 / 响应：

```json
{ "type": "refresh_model_registry" }
```

```json
{ "type": "response", "command": "refresh_model_registry", "success": true, "data": { "modelCount": 42, "error": null } }
```

实现要点：

- **顺序关键**：`authStorage.reload()` 必须在 `refresh()` 之前；`refresh()` 自身不重载 auth（`model-registry.ts:432`）。
- `data.error` 传 `getError()`（models.json 解析失败时非 null，但不阻止内置模型可用）。
- `data.modelCount` 用刷新后的 `getAvailable().length`（已配 auth 的可用模型数）。
- 改完 **必须 `bun run build:sidecar`** 重新编译 sidecar 二进制（见 2.3）。

### 6.2 Tauri 命令（新文件 `commands/providers.rs`）

| 命令 | 职责 |
|------|------|
| `get_provider_config` | 读 `~/.pi/agent/models.json` + `auth.json`；文件不存在返回空结构；解析失败返回 error 字段 |
| `set_provider_config` | 接收 `{ modelsJson, authJson }`；基础 schema 校验；tmp + rename 原子写；成功后广播 refresh |
| `refresh_model_registry` | 对 `PiManager` 全部活跃 client 发 RPC；汇总 partial errors |

路径解析：优先 `PI_CODING_AGENT_DIR` / 默认 `~/.pi/agent/`（与 Pi `getAgentDir()` 一致）。

### 6.3 Rust ↔ RPC

- `PiOutbound` 新增 `RefreshModelRegistry { id: Option<String> }`。
- `lib.rs` 注册上述三 command。
- `client.rs` 的 `ensure_id` / 测试补序列化用例。

### 6.4 前端 bridge（`pi.ts`）

```ts
getProviderConfig: () => invoke<ProviderConfigPayload>('get_provider_config'),
setProviderConfig: (config: ProviderConfigPayload) =>
  invoke<void>('set_provider_config', { config }),
refreshModelRegistry: () => invoke<RefreshResult>('refresh_model_registry'),
```

`setProviderConfig` 内部应：写盘 + refresh（单一事务语义）；失败时 UI 展示 error 且不假装成功。

> `refresh_model_registry` 响应 `{ modelCount, error }` 供 toast/诊断；刷新后**前端重新调用 `getAvailableModels`** 取新列表（返回完整 `Model[]`，已 auth 过滤）。未配 Key 的模型不会出现在该列表，UI 文案应提示「需配置 Key 后模型才可选」。

## 7. 迁移

首次打开「供应商」页时（一次性）：

1. 若 `runtime-settings.json` 含非空 `OPENAI_API_KEY`，且 `auth.json` 无 `openai` → 写入 `auth.json.openai`。
2. 从 runtime-settings **删除** `OPENAI_API_KEY` 并写回。
3. 不迁移 / 不删除 `IMAGE_*`、`TTS_*`、`KB_EMBED_*`、`MEMORY_EMBED_*`。

迁移逻辑放前端 hook 或 Tauri command 均可；须幂等。

## 8. 测试

| 层 | 内容 |
|----|------|
| 前端 | `providerConfigAdapter` 单测（round-trip、内置/自定义、override） |
| 前端 | `ProvidersSettings` 渲染 + mock invoke 保存流程 |
| Rust | 原子写盘、refresh 广播多 workspace、路径解析 |
| Pi | `modes/rpc/` 新增 rpc-mode 测试：发 `refresh_model_registry` 验证 reload→refresh 顺序与响应（in-memory AuthStorage / ModelRegistry） |

## 9. 阶段二预留

- `models.json` 模型增加 `kind: chat | image | embedding | tts`（或分 registry 段）。
- 扩展改造：`resolveImageConfig` / `resolveTtsConfig` / `resolveEmbeddingConfig` 从 provider 库解析 endpoint + key + model。
- settings 移除 IMAGE/TTS/KB_EMBED/MEMORY_EMBED 字段；各能力仅保留行为开关（如尺寸、voice、topK）。

## 10. 风险与缓解

| 风险 | 缓解 |
|------|------|
| models.json schema 与 Pi 版本漂移 | 适配层集中序列化；保存前校验；展示 registry 返回的 parse error |
| 多 workspace 部分 refresh 失败 | `set_provider_config` 返回 `{ refreshed: string[], failed: { workspace, error }[] }` |
| pi fork 与上游 rebase 冲突 | RPC 改动尽量小（单命令）；文档记录 patch 点 |
| Key 明文经 Tauri 传输 | 本地桌面 app，与现有 password 设置字段一致；auth.json mode 0600 |
| 填 Key 后模型不出现（refresh 未 reload auth） | `refreshModelRegistry` 内**先 `authStorage.reload()` 再 `modelRegistry.refresh()`**；测试覆盖该顺序 |
| 改 pi 源未重编译 sidecar，"改了没反应" | 实现步骤写明 `bun run build:sidecar`；`dev:full` / CI 纳入该步 |
| Tauri 直写 auth.json 绕过 pi 的 `proper-lockfile`，与 OAuth token 刷新竞态 | 桌面单用户概率低；如需严谨可改为 auth.json 也走 RPC 让 pi 持锁写，本期接受文件级原子写（tmp+rename） |

## 11. 实现文件清单（阶段一）

| 区域 | 文件 |
|------|------|
| Pi（改后须 `build:sidecar`） | `pi/packages/coding-agent/src/modes/rpc/rpc-types.ts`（命令/响应类型）、`pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts`（`switch` 加 `refresh_model_registry` case） |
| Tauri | `src-tauri/src/commands/providers.rs`（新）、`pi/types.rs`（`PiOutbound::RefreshModelRegistry`）、`lib.rs`（注册三命令） |
| 前端 | `features/settings/ProvidersSettings.tsx`、`providerPresets.ts`、`providerConfigAdapter.ts`、`settingsSchema.ts`、`SettingsPanel.tsx`、`lib/pi.ts` |
| 测试 | 前端 `providerConfigAdapter.test.ts` / `ProvidersSettings.test.tsx`；Rust `#[cfg(test)]`；Pi `modes/rpc/` rpc-mode 测试 |

**构建/验证步骤**：改 pi 源后 `bun run build:sidecar`（或 `build:sidecar:dev`）重新生成 `src-tauri/binaries/pi-<triple>`，再起 app 验证；否则 RPC 新命令不会进运行时。

---

**规格自检（2026-06-15）**

- [x] 无「待定/TODO」占位
- [x] 阶段一/二边界一致；第四节与 1.2 不矛盾
- [x] 架构（文件 + RPC + UI）与成功标准对齐
- [x] 范围可用单一实现计划覆盖（阶段二单独 spec）

**代码核对修订（2026-06-15，第三轮：Shell+Read 实地核验，修正第二轮基于损坏检索结果的误判）**

> 说明：第二轮 review 时 Grep/Glob 对 `pi/` 子树返回了损坏/空结果，导致误判文件位置；本轮改用 Shell 目录列举 + Read 重新核验全部锚点。

- [x] RPC handler 真实落点：`modes/rpc/rpc-mode.ts` 的 `switch` + `modes/rpc/rpc-types.ts`（**实测无 `sdk/` 目录、无 `rpc-mode-handlers.ts`**；spec 原始 `modes/rpc/` 方向本就正确）
- [x] 撤回「需在 `AgentSession` 加方法」：`session.modelRegistry`（含公开 `authStorage`）在 handler 内可达，直接在新 `case` 实现
- [x] auth.json 缓存缺口属实并保留：刷新先 `authStorage.reload()` 再 `modelRegistry.refresh()`（`refresh()` 不重载 auth，已核 `model-registry.ts:432`、`auth-storage.ts:208`）
- [x] 撤回误判：`get_available_models` 返回**完整 `Model[]`**（非「字段有限」），现状/6.4 已更正
- [x] sidecar 构建依赖属实并保留：改 pi 源须 `bun run build:sidecar`（核 `scripts/build-sidecar.mjs` 入口 `cli.ts`）
- [x] auth.json 文件锁竞态：保留为风险（Tauri 直写绕过 pi 的 `proper-lockfile`）
