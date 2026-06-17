# 供应商与模型管理（阶段一）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 tauri-agent 设置里加「供应商管理中心」，对齐 Pi 的 `~/.pi/agent/models.json` + `auth.json`，保存后经 RPC 热重载即时生效，并让对话/标题/子代理/记忆 LLM 共用同一模型来源。

**架构：** 前端静态内置供应商目录 + 自定义供应商 → Tauri 原子读写 Pi 标准文件 → 广播 `refresh_model_registry` RPC → pi 进程 `authStorage.reload()` + `modelRegistry.refresh()`。

**技术栈：** TypeScript（pi sidecar / React 前端）、Rust（Tauri）、Vitest、`#[cfg(test)]`。

---

## 关键约束（务必先读）

1. **改 pi 源后必须重编译 sidecar**：`cd tauri-agent && bun run build:sidecar`（产物 `src-tauri/binaries/pi-<triple>`）。否则 RPC 新命令不进运行时，表现为"改了没反应"。
2. **工具可靠性**：`Grep`/`Glob` 在 `pi/` 子树会返回空/损坏结果（被忽略），核对 pi 源**只用 `Read` + Shell `Get-ChildItem`**。`tauri-agent/` 下检索正常。
3. **reload 顺序**：刷新必须 `authStorage.reload()` **先于** `modelRegistry.refresh()`（`refresh()` 不重载 auth）。
4. **路径**：agent 目录 = 环境变量 `PI_CODING_AGENT_DIR`，否则 `~/.pi/agent`（与 pi `getAgentDir()` 默认一致）。
5. 禁止 emoji（项目规则）。

## 文件结构

| 区域 | 文件 | 职责 |
|------|------|------|
| Pi | `pi/packages/coding-agent/src/modes/rpc/rpc-types.ts` | `RpcCommand`/`RpcResponse` 加 `refresh_model_registry` |
| Pi | `pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts` | `switch` 加 case，reload+refresh |
| Rust | `src-tauri/src/pi/types.rs` | `PiOutbound::RefreshModelRegistry` |
| Rust | `src-tauri/src/pi/client.rs` | `ensure_id` 覆盖新变体 |
| Rust | `src-tauri/src/pi/manager.rs` | `all()` 列举所有 client |
| Rust | `src-tauri/src/commands/providers.rs`（新） | `get_provider_config`/`set_provider_config`/`refresh_model_registry` |
| Rust | `src-tauri/src/commands/mod.rs`、`lib.rs` | 注册模块与命令 |
| 前端 | `src/lib/pi.ts` | 三个 bridge 方法 + 类型 |
| 前端 | `src/features/settings/providerPresets.ts`（新） | 内置供应商目录 |
| 前端 | `src/features/settings/providerConfigAdapter.ts`（新） | UI ↔ models.json/auth.json |
| 前端 | `src/features/settings/ProvidersSettings.tsx`（新） | 供应商管理 UI |
| 前端 | `src/features/settings/settingsSchema.ts`、`SettingsPanel.tsx` | 加 `providers` 分类 + 特判渲染 + 移除 OPENAI_API_KEY |

---

## 任务 1：Pi RPC — `refresh_model_registry`

**文件：**
- 修改：`pi/packages/coding-agent/src/modes/rpc/rpc-types.ts`
- 修改：`pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- 测试：`pi/packages/coding-agent/src/modes/rpc/rpc-mode.test.ts`（若不存在则新建）

- [ ] **步骤 1：rpc-types.ts 加命令与响应类型**

在 `RpcCommand` 联合的 `// Model` 区追加：

```ts
	| { id?: string; type: "refresh_model_registry" }
```

在 `RpcResponse` 联合的 Model 区追加：

```ts
	| {
			id?: string;
			type: "response";
			command: "refresh_model_registry";
			success: true;
			data: { modelCount: number; error: string | null };
	  }
```

- [ ] **步骤 2：rpc-mode.ts 的 `switch` 加 case**

在 `case "get_available_models": { ... }` 之后插入：

```ts
			case "refresh_model_registry": {
				session.modelRegistry.authStorage.reload();
				session.modelRegistry.refresh();
				const models = await session.modelRegistry.getAvailable();
				return success(id, "refresh_model_registry", {
					modelCount: models.length,
					error: session.modelRegistry.getError() ?? null,
				});
			}
```

- [ ] **步骤 3：写测试**（用 Read 确认现有 test 文件的构造方式后对齐；若无则建最小用例）

```ts
// 断言：发 refresh_model_registry 后，先 reload 再 refresh，且响应含 modelCount/error
import { describe, expect, it, vi } from "vitest";

it("refresh_model_registry reloads auth then refreshes registry", async () => {
	const calls: string[] = [];
	const modelRegistry = {
		authStorage: { reload: () => calls.push("reload") },
		refresh: () => calls.push("refresh"),
		getAvailable: async () => [{ id: "m1" }],
		getError: () => null,
	};
	// 构造一个最小 session/runtimeHost 注入 modelRegistry，调用 handleCommand
	// （按现有测试装配方式；核心断言如下）
	expect(calls).toEqual(["reload", "refresh"]);
});
```

- [ ] **步骤 4：类型检查**

运行：`cd pi && npx tsgo --noEmit`（或仓库既有 `npm run check`）
预期：通过；`refresh_model_registry` 在 `success(...)` 的联合里被识别。

- [ ] **步骤 5：重编译 sidecar 并冒烟**

运行：`cd tauri-agent && bun run build:sidecar:dev`
预期：生成 `src-tauri/binaries/pi-<triple>`，无报错。

- [ ] **步骤 6：Commit**

```bash
git add pi/packages/coding-agent/src/modes/rpc/
git commit -m "feat(pi): add refresh_model_registry RPC (reload auth + refresh registry)"
```

---

## 任务 2：Rust — `PiOutbound::RefreshModelRegistry`

**文件：**
- 修改：`src-tauri/src/pi/types.rs`
- 修改：`src-tauri/src/pi/client.rs:125-157`（`ensure_id`）

- [ ] **步骤 1：types.rs 加变体**

在 `PiOutbound` 枚举末尾（`AbortRetry` 后）追加：

```rust
    RefreshModelRegistry {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
```

- [ ] **步骤 2：client.rs 的 `ensure_id` 覆盖新变体**

在 `match cmd` 的 `| AbortRetry { id } => fill!(id),` 改为同时匹配：

```rust
        | AbortRetry { id }
        | RefreshModelRegistry { id } => fill!(id),
```

- [ ] **步骤 3：types.rs 加序列化测试**

在 `mod tests` 追加：

```rust
    #[test]
    fn serializes_refresh_model_registry_as_snake_case() {
        let s = serde_json::to_string(&PiOutbound::RefreshModelRegistry { id: None }).unwrap();
        assert!(s.contains("\"type\":\"refresh_model_registry\""), "got: {s}");
        assert!(!s.contains("\"id\""));
    }
```

- [ ] **步骤 4：运行测试**

运行：`cd tauri-agent/src-tauri && cargo test pi::types`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src-tauri/src/pi/types.rs tauri-agent/src-tauri/src/pi/client.rs
git commit -m "feat(tauri): add RefreshModelRegistry PiOutbound variant"
```

---

## 任务 3：Rust — `PiManager.all()` 列举所有 client

**文件：**
- 修改：`src-tauri/src/pi/manager.rs`

- [ ] **步骤 1：写测试**

在 `mod tests` 追加：

```rust
    #[tokio::test]
    async fn all_returns_every_open_client() {
        let mgr = PiManager::new();
        mgr.get_or_open("/ws/a", || Ok(fake_client("/ws/a"))).await.unwrap();
        mgr.get_or_open("/ws/b", || Ok(fake_client("/ws/b"))).await.unwrap();
        let all = mgr.all().await;
        assert_eq!(all.len(), 2);
    }
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent/src-tauri && cargo test pi::manager::tests::all_returns`
预期：编译失败（`all` 未定义）。

- [ ] **步骤 3：实现 `all()`**

在 `impl PiManager` 内 `get` 之后加：

```rust
    /// 返回所有已打开 workspace 的 (路径, client) 快照。
    pub async fn all(&self) -> Vec<(String, Arc<PiClient>)> {
        self.clients
            .lock()
            .await
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent/src-tauri && cargo test pi::manager`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src-tauri/src/pi/manager.rs
git commit -m "feat(tauri): PiManager.all() to broadcast to all workspaces"
```

---

## 任务 4：Rust — `commands/providers.rs`

**文件：**
- 创建：`src-tauri/src/commands/providers.rs`
- 修改：`src-tauri/src/commands/mod.rs`
- 修改：`src-tauri/src/lib.rs:42-107`（invoke_handler）

- [ ] **步骤 1：新建 `providers.rs`**

```rust
use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::{Manager, State};

use crate::pi::types::PiOutbound;
use crate::pi::PiManager;

/// 解析 ~/.pi/agent 目录（与 pi getAgentDir 默认一致）。
fn agent_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("PI_CODING_AGENT_DIR") {
        if !dir.is_empty() {
            return Ok(PathBuf::from(dir));
        }
    }
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(home.join(".pi").join("agent"))
}

fn read_opt(path: &PathBuf) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

fn atomic_write(path: &PathBuf, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfigPayload {
    pub models_json: Option<String>,
    pub auth_json: Option<String>,
    pub agent_dir: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedWorkspace {
    pub workspace: String,
    pub error: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RefreshResult {
    pub refreshed: Vec<String>,
    pub failed: Vec<FailedWorkspace>,
}

async fn broadcast_refresh(mgr: &PiManager) -> RefreshResult {
    let mut out = RefreshResult::default();
    for (ws, client) in mgr.all().await {
        match client.send(PiOutbound::RefreshModelRegistry { id: None }).await {
            Ok(resp) if resp.success => out.refreshed.push(ws),
            Ok(resp) => out.failed.push(FailedWorkspace {
                workspace: ws,
                error: resp.error.unwrap_or_else(|| "refresh failed".into()),
            }),
            Err(e) => out.failed.push(FailedWorkspace { workspace: ws, error: e.to_string() }),
        }
    }
    out
}

#[tauri::command]
pub async fn get_provider_config(app: tauri::AppHandle) -> Result<ProviderConfigPayload, String> {
    let dir = agent_dir(&app)?;
    Ok(ProviderConfigPayload {
        models_json: read_opt(&dir.join("models.json")),
        auth_json: read_opt(&dir.join("auth.json")),
        agent_dir: dir.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn set_provider_config(
    models_json: String,
    auth_json: String,
    app: tauri::AppHandle,
    mgr: State<'_, Arc<PiManager>>,
) -> Result<RefreshResult, String> {
    // 校验是合法 JSON，避免写坏文件。
    serde_json::from_str::<serde_json::Value>(&models_json)
        .map_err(|e| format!("models.json 不是合法 JSON: {e}"))?;
    serde_json::from_str::<serde_json::Value>(&auth_json)
        .map_err(|e| format!("auth.json 不是合法 JSON: {e}"))?;

    let dir = agent_dir(&app)?;
    atomic_write(&dir.join("models.json"), &models_json)?;
    atomic_write(&dir.join("auth.json"), &auth_json)?;

    Ok(broadcast_refresh(&mgr).await)
}

#[tauri::command]
pub async fn refresh_model_registry(
    mgr: State<'_, Arc<PiManager>>,
) -> Result<RefreshResult, String> {
    Ok(broadcast_refresh(&mgr).await)
}
```

- [ ] **步骤 2：mod.rs 注册模块**

在 `src-tauri/src/commands/mod.rs` 的模块声明区加 `pub mod providers;`（按字母序放在 `pub mod memory;` 后）。

- [ ] **步骤 3：lib.rs 注册命令**

在 `invoke_handler![...]` 的 `commands::set_settings,` 之后加：

```rust
            commands::providers::get_provider_config,
            commands::providers::set_provider_config,
            commands::providers::refresh_model_registry,
```

- [ ] **步骤 4：原子写盘单测**

在 `providers.rs` 末尾加：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_then_read_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("pi-prov-{}.json", std::process::id()));
        atomic_write(&tmp, "{\"providers\":{}}").unwrap();
        assert_eq!(read_opt(&tmp).as_deref(), Some("{\"providers\":{}}"));
        let _ = std::fs::remove_file(&tmp);
    }
}
```

- [ ] **步骤 5：编译 + 测试**

运行：`cd tauri-agent/src-tauri && cargo test commands::providers && cargo build`
预期：PASS / 编译通过。

- [ ] **步骤 6：Commit**

```bash
git add tauri-agent/src-tauri/src/commands/providers.rs tauri-agent/src-tauri/src/commands/mod.rs tauri-agent/src-tauri/src/lib.rs
git commit -m "feat(tauri): provider config read/write commands + refresh broadcast"
```

---

## 任务 5：前端 bridge（`pi.ts`）

**文件：**
- 修改：`src/lib/pi.ts`

- [ ] **步骤 1：加类型与方法**

在 `pi` 对象内（`setSettings` 附近）加：

```ts
  getProviderConfig: () => invoke<ProviderConfigPayload>('get_provider_config'),
  setProviderConfig: (modelsJson: string, authJson: string) =>
    invoke<RefreshResult>('set_provider_config', { modelsJson, authJson }),
  refreshModelRegistry: () => invoke<RefreshResult>('refresh_model_registry'),
```

在文件类型区加：

```ts
export interface ProviderConfigPayload {
  modelsJson: string | null;
  authJson: string | null;
  agentDir: string;
}
export interface RefreshResult {
  refreshed: string[];
  failed: { workspace: string; error: string }[];
}
```

- [ ] **步骤 2：类型检查**

运行：`cd tauri-agent && bun run build`（或 `tsc -p tsconfig.json --noEmit`）
预期：通过。

- [ ] **步骤 3：Commit**

```bash
git add tauri-agent/src/lib/pi.ts
git commit -m "feat(ui): pi bridge for provider config + refresh"
```

---

## 任务 6：前端内置供应商目录（`providerPresets.ts`）

**文件：**
- 创建：`src/features/settings/providerPresets.ts`

- [ ] **步骤 1：定义预设**

```ts
export type ApiType = 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai';

export interface ProviderPreset {
  id: string;        // 与 Pi provider id 一致（如 'openai'）
  name: string;      // 显示名
  api: ApiType;      // 默认 api 类型
  baseUrlHint?: string;
}

/** 内置供应商目录：仅用于 UI 展示与默认值；模型列表由 Pi 内置 registry 提供。 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'openai', name: 'OpenAI', api: 'openai-responses', baseUrlHint: 'https://api.openai.com/v1' },
  { id: 'anthropic', name: 'Anthropic', api: 'anthropic-messages', baseUrlHint: 'https://api.anthropic.com' },
  { id: 'google', name: 'Google Gemini', api: 'google-generative-ai' },
  { id: 'deepseek', name: 'DeepSeek', api: 'openai-completions', baseUrlHint: 'https://api.deepseek.com' },
  { id: 'groq', name: 'Groq', api: 'openai-completions', baseUrlHint: 'https://api.groq.com/openai/v1' },
  { id: 'openrouter', name: 'OpenRouter', api: 'openai-completions', baseUrlHint: 'https://openrouter.ai/api/v1' },
  { id: 'xai', name: 'xAI Grok', api: 'openai-completions', baseUrlHint: 'https://api.x.ai/v1' },
  { id: 'moonshotai', name: 'Moonshot Kimi', api: 'openai-completions', baseUrlHint: 'https://api.moonshot.cn/v1' },
  { id: 'zai', name: 'Z.AI', api: 'openai-completions' },
  { id: 'minimax', name: 'MiniMax', api: 'openai-completions' },
  { id: 'xiaomi', name: 'Xiaomi MiMo', api: 'openai-completions' },
];
```

> 注：`api`/`baseUrlHint` 仅作自定义模型时的默认；内置 provider 配 Key 走 auth.json，模型来自 Pi registry。实现时用 Read 核对 `pi/packages/ai/src/types.ts` 的 `KnownProvider` 名称保持 id 一致。

- [ ] **步骤 2：Commit**

```bash
git add tauri-agent/src/features/settings/providerPresets.ts
git commit -m "feat(ui): built-in provider preset catalog"
```

---

## 任务 7：前端适配层（`providerConfigAdapter.ts`）

**文件：**
- 创建：`src/features/settings/providerConfigAdapter.ts`
- 测试：`src/features/settings/providerConfigAdapter.test.ts`

- [ ] **步骤 1：类型与解析/序列化**

```ts
export interface UiModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ('text' | 'image')[];
  contextWindow?: number;
  maxTokens?: number;
}
export interface UiProvider {
  id: string;
  name: string;
  builtIn: boolean;
  api?: string;
  baseUrl?: string;
  apiKey?: string;       // 内置: 来自 auth.json；自定义: models.json
  models: UiModel[];     // 用户自定义/追加的模型（不含 Pi 内置只读模型）
}

interface ModelsJson { providers?: Record<string, {
  name?: string; baseUrl?: string; apiKey?: string; api?: string; models?: UiModel[];
}>; }
type AuthJson = Record<string, { type?: string; key?: string } | undefined>;

export function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/** auth.json + models.json + 预设 → UI 供应商列表。 */
export function loadState(
  modelsRaw: string | null,
  authRaw: string | null,
  presets: { id: string; name: string; api?: string }[],
): UiProvider[] {
  const models = parseJson<ModelsJson>(modelsRaw, {});
  const auth = parseJson<AuthJson>(authRaw, {});
  const providers = models.providers ?? {};

  const builtIns: UiProvider[] = presets.map((p) => ({
    id: p.id,
    name: providers[p.id]?.name ?? p.name,
    builtIn: true,
    api: providers[p.id]?.api ?? p.api,
    baseUrl: providers[p.id]?.baseUrl,
    apiKey: auth[p.id]?.key ?? providers[p.id]?.apiKey,
    models: providers[p.id]?.models ?? [],
  }));

  const presetIds = new Set(presets.map((p) => p.id));
  const customs: UiProvider[] = Object.entries(providers)
    .filter(([id]) => !presetIds.has(id))
    .map(([id, c]) => ({
      id,
      name: c.name ?? id,
      builtIn: false,
      api: c.api,
      baseUrl: c.baseUrl,
      apiKey: auth[id]?.key ?? c.apiKey,
      models: c.models ?? [],
    }));

  return [...builtIns, ...customs];
}

/** UI 列表 → { modelsJson, authJson }。内置 Key 写 auth.json；自定义 provider 写 models.json(含 apiKey)。 */
export function serializeState(providers: UiProvider[]): { modelsJson: string; authJson: string } {
  const modelsProviders: ModelsJson['providers'] = {};
  const auth: AuthJson = {};

  for (const p of providers) {
    if (p.apiKey) auth[p.id] = { type: 'api_key', key: p.apiKey };

    if (p.builtIn) {
      // 仅当有 override（baseUrl / 自定义模型）才写 models.json 段
      if (p.baseUrl || p.models.length > 0) {
        modelsProviders![p.id] = {
          ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
          ...(p.models.length ? { models: p.models } : {}),
        };
      }
    } else {
      modelsProviders![p.id] = {
        name: p.name,
        api: p.api,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,   // 自定义 provider schema 要求 apiKey
        models: p.models,
      };
    }
  }

  return {
    modelsJson: JSON.stringify({ providers: modelsProviders }, null, 2),
    authJson: JSON.stringify(auth, null, 2),
  };
}
```

- [ ] **步骤 2：写测试**

```ts
import { describe, expect, it } from 'vitest';
import { loadState, serializeState } from './providerConfigAdapter';

const presets = [{ id: 'openai', name: 'OpenAI', api: 'openai-responses' }];

describe('providerConfigAdapter', () => {
  it('loads built-in key from auth.json', () => {
    const ps = loadState('{}', '{"openai":{"type":"api_key","key":"sk-x"}}', presets);
    expect(ps[0]).toMatchObject({ id: 'openai', builtIn: true, apiKey: 'sk-x' });
  });

  it('round-trips a custom provider', () => {
    const custom = [{
      id: 'my', name: 'My', builtIn: false, api: 'openai-completions',
      baseUrl: 'https://x/v1', apiKey: 'k', models: [{ id: 'm1', name: 'M1' }],
    }];
    const { modelsJson, authJson } = serializeState(custom as never);
    const back = loadState(modelsJson, authJson, presets).find((p) => p.id === 'my');
    expect(back).toMatchObject({ id: 'my', apiKey: 'k', baseUrl: 'https://x/v1' });
    expect(back?.models[0].id).toBe('m1');
  });

  it('built-in without key/override produces no models.json entry', () => {
    const { modelsJson } = serializeState([
      { id: 'openai', name: 'OpenAI', builtIn: true, models: [] } as never,
    ]);
    expect(JSON.parse(modelsJson).providers.openai).toBeUndefined();
  });
});
```

- [ ] **步骤 3：运行测试**

运行：`cd tauri-agent && bunx vitest run src/features/settings/providerConfigAdapter.test.ts`
预期：PASS。

- [ ] **步骤 4：Commit**

```bash
git add tauri-agent/src/features/settings/providerConfigAdapter.ts tauri-agent/src/features/settings/providerConfigAdapter.test.ts
git commit -m "feat(ui): provider config adapter (models.json/auth.json <-> UI)"
```

---

## 任务 8：前端 UI（`ProvidersSettings.tsx`）

**文件：**
- 创建：`src/features/settings/ProvidersSettings.tsx`
- 测试：`src/features/settings/ProvidersSettings.test.tsx`

- [ ] **步骤 1：组件骨架（主从布局 + 保存）**

参照 `AppearanceSettings.tsx` 用 `createStaticStyles` + `cssVar`；图标用 `@lobehub/ui` 的 `Icon` + `lucide-react`（禁 emoji）。核心结构：

```tsx
import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { Boxes, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { pi } from '../../lib/pi';
import { PROVIDER_PRESETS } from './providerPresets';
import { loadState, serializeState, type UiProvider } from './providerConfigAdapter';

const styles = createStaticStyles(({ css }) => ({
  root: css`display: flex; height: 100%; min-height: 0;`,
  list: css`width: 220px; flex: 0 0 auto; overflow-y: auto; border-inline-end: 1px solid ${cssVar.colorBorderSecondary}; padding: 8px;`,
  item: css`display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: ${cssVar.borderRadius}; cursor: pointer; color: ${cssVar.colorTextSecondary}; &:hover { background: ${cssVar.colorFillTertiary}; }`,
  itemActive: css`background: ${cssVar.colorFillSecondary}; color: ${cssVar.colorText};`,
  detail: css`flex: 1; min-width: 0; overflow-y: auto; padding: 20px 24px; max-width: 640px;`,
  groupTitle: css`padding: 12px 12px 4px; font-size: 12px; color: ${cssVar.colorTextDescription};`,
}));

export function ProvidersSettings() {
  const [providers, setProviders] = useState<UiProvider[]>([]);
  const [activeId, setActiveId] = useState<string>('openai');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void pi.getProviderConfig().then((cfg) => {
      setProviders(loadState(cfg.modelsJson, cfg.authJson, PROVIDER_PRESETS));
    });
  }, []);

  const active = providers.find((p) => p.id === activeId);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const { modelsJson, authJson } = serializeState(providers);
      const res = await pi.setProviderConfig(modelsJson, authJson);
      if (res.failed.length) setError(`部分工作区刷新失败：${res.failed.map((f) => f.workspace).join(', ')}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const patchActive = (patch: Partial<UiProvider>) =>
    setProviders((ps) => ps.map((p) => (p.id === activeId ? { ...p, ...patch } : p)));

  // ... 渲染左栏（内置/自定义分组）+ 右栏详情（Key/BaseURL/模型列表/添加模型）+ 顶栏保存按钮
  return <div className={styles.root}>{/* 见步骤 2/3 */}</div>;
}
```

- [ ] **步骤 2：左栏列表 + 右栏详情字段**

- 左栏：`PROVIDER_PRESETS` 渲染「内置」组，`providers.filter(p => !p.builtIn)` 渲染「自定义」组；每项状态点（`p.apiKey ? 已配置 : 未配置`）。
- 右栏：`active.apiKey`（password input → `patchActive({ apiKey })`）、`active.baseUrl`（text）、自定义 provider 额外 `name`/`id`/`api`、模型表（map `active.models`，每行可删 `Trash2`）、「添加模型」按钮 `Plus`。
- 顶栏：「保存」按钮 `onClick={() => void save()}`，`disabled={saving}`；`error` 显示在下方。

> 模型增删用本地 state（合并进 `active.models`），点「保存」一并落盘。可用 `@lobehub/ui` 的 `Modal`/`Input` 或 base-ui 等现有组件；避免 emoji。

- [ ] **步骤 3：迁移逻辑（OPENAI_API_KEY → auth.json）**

在 `useEffect` 加载后执行一次幂等迁移：

```tsx
useEffect(() => {
  void (async () => {
    const settings = await pi.getSettings();
    const legacy = (settings.OPENAI_API_KEY ?? '').trim();
    if (!legacy) return;
    const cfg = await pi.getProviderConfig();
    const ps = loadState(cfg.modelsJson, cfg.authJson, PROVIDER_PRESETS);
    const openai = ps.find((p) => p.id === 'openai');
    if (openai && !openai.apiKey) {
      openai.apiKey = legacy;
      const { modelsJson, authJson } = serializeState(ps);
      await pi.setProviderConfig(modelsJson, authJson);
    }
    const { OPENAI_API_KEY: _drop, ...rest } = settings;
    await pi.setSettings(rest);
    setProviders(ps);
  })();
}, []);
```

- [ ] **步骤 4：写测试（渲染 + 保存流程，mock invoke）**

参照 `useSettingsForm.test.ts` 的 `vi.mock('../../lib/pi', ...)` 模式：

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { getProviderConfig, setProviderConfig, getSettings, setSettings } = vi.hoisted(() => ({
  getProviderConfig: vi.fn(() => Promise.resolve({ modelsJson: '{}', authJson: '{}', agentDir: '/a' })),
  setProviderConfig: vi.fn(() => Promise.resolve({ refreshed: ['/ws'], failed: [] })),
  getSettings: vi.fn(() => Promise.resolve({})),
  setSettings: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../lib/pi', () => ({ pi: { getProviderConfig, setProviderConfig, getSettings, setSettings } }));

import { ProvidersSettings } from './ProvidersSettings';

it('saves provider key via setProviderConfig', async () => {
  render(<ProvidersSettings />);
  await waitFor(() => expect(getProviderConfig).toHaveBeenCalled());
  // 输入 key、点保存后断言 setProviderConfig 被调用（具体选择器按实现 data-testid）
});
```

- [ ] **步骤 5：运行测试**

运行：`cd tauri-agent && bunx vitest run src/features/settings/ProvidersSettings.test.tsx`
预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add tauri-agent/src/features/settings/ProvidersSettings.tsx tauri-agent/src/features/settings/ProvidersSettings.test.tsx
git commit -m "feat(ui): providers settings panel + legacy key migration"
```

---

## 任务 9：接入设置面板 + 移除 OPENAI_API_KEY

**文件：**
- 修改：`src/features/settings/settingsSchema.ts`
- 修改：`src/features/settings/SettingsPanel.tsx`
- 修改：`src/features/settings/settingsSchema.test.ts`（若断言了 general 字段）

- [ ] **步骤 1：settingsSchema 加分类、移除 key**

在 `SETTINGS_SCHEMA` 的 `general` 之前（或之后）加分类，并从 `general.fields` 删除 `OPENAI_API_KEY` 项：

```ts
  {
    id: 'providers',
    title: '供应商',
    group: '核心',
    icon: Boxes,
    fields: [],
  },
```

（`Boxes` 已从 `lucide-react` 引入；`general.fields` 仅保留 `titleModel`。）

- [ ] **步骤 2：SettingsPanel 特判渲染**

`import { ProvidersSettings } from './ProvidersSettings';`，在 `activeId === 'appearance'` 的三元里增加分支：

```tsx
{activeId === 'appearance' ? (
  <AppearanceSettings />
) : activeId === 'providers' ? (
  <ProvidersSettings />
) : (
  sections.map(/* ... 原有 ... */)
)}
```

- [ ] **步骤 3：更新/运行受影响测试**

运行：`cd tauri-agent && bunx vitest run src/features/settings/settingsSchema.test.ts src/features/settings/SettingsPanel.test.tsx`
预期：PASS（如断言 general 含 OPENAI_API_KEY 需同步更新）。

- [ ] **步骤 4：Commit**

```bash
git add tauri-agent/src/features/settings/settingsSchema.ts tauri-agent/src/features/settings/SettingsPanel.tsx tauri-agent/src/features/settings/settingsSchema.test.ts
git commit -m "feat(ui): add Providers settings category, drop OPENAI_API_KEY field"
```

---

## 任务 10：端到端联调验证

- [ ] **步骤 1：重编译 sidecar**

运行：`cd tauri-agent && bun run build:sidecar`
预期：成功生成二进制。

- [ ] **步骤 2：起 app 手测成功标准**

运行：`cd tauri-agent && bun run tauri dev`
验证：
1. 为 ≥3 个内置供应商填 Key → 保存 → 对话模型下拉立即出现对应模型（无需重启）。
2. 新增自定义 OpenAI 兼容供应商 + 模型 → 保存 → `getAvailableModels` 含新模型。
3. 标题/子代理/记忆模型下拉与对话共用同一列表。
4. 设置「通用与模型」无 `OPENAI_API_KEY`；旧值已迁入 `~/.pi/agent/auth.json`。

- [ ] **步骤 3：最终 Commit（如有收尾改动）**

```bash
git add -A
git commit -m "chore: provider/model management phase 1 e2e polish"
```

---

## 自检

**规格覆盖度：**
- spec §6.1（Pi RPC）→ 任务 1；§6.3（PiOutbound/ensure_id）→ 任务 2；§6.2（Tauri 命令 + 广播）→ 任务 3/4；§6.4（bridge）→ 任务 5；§4.3（预设）→ 任务 6；§4.4（适配层）→ 任务 7；§5（UI）→ 任务 8；§5.6 + §5.1（接入/清理）→ 任务 9；§7（迁移）→ 任务 8 步骤 3；§8（测试）→ 各任务内联；§10 验证 → 任务 10。
- 阶段二（image/tts/embedding）按 spec §9 不在本计划。

**占位符扫描：** 无 TODO/待定；UI 大组件（任务 8）给出骨架 + 关键逻辑（save/migrate/adapter 全代码），渲染细节按骨架与 data-testid 落实。

**类型一致性：** `RefreshResult`/`ProviderConfigPayload`（Rust camelCase ↔ ts）一致；`UiProvider`/`UiModel` 贯穿适配层与 UI；`refresh_model_registry` 命令名在 pi/types/Rust/bridge 三处一致（snake_case）。

**构建依赖提醒：** 任务 1/10 已显式包含 `bun run build:sidecar`。
