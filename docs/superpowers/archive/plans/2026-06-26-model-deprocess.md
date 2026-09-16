# SP-1 模型去进程化（probe-models）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 提供项目无关的模型枚举入口，让模型选择器在未打开任何项目时也能列出运行时解析后的模型。

**架构：** sidecar 加一次性子命令 `probe-models`（不起 RPC 运行时，用 `AuthStorage` + `ModelRegistry` 列模型打 JSON），Tauri 加 `list_models_global` spawn 该子命令解析，前端选择器全局可用。

**技术栈：** TypeScript（cli sidecar）、Rust（Tauri command）、`@earendil-works/pi-coding-agent` 的 `AuthStorage`/`ModelRegistry`、vitest、cargo test。

设计来源：`docs/superpowers/specs/2026-06-26-model-deprocess-design.md`。

---

## 文件结构

- 创建：`cli/src/probe-models.ts` —— `collectModels()`（纯逻辑：ModelRegistry → 可序列化数组）+ `runModelProbe()`（CLI 入口，打 JSON 到 stdout）。
- 创建：`cli/src/probe-models.test.ts` —— `collectModels` 的单元测试（注入假 registry）。
- 修改：`cli/src/main.ts` —— 在 `isRpcMode` 判断前加 `probe-models` 分支。
- 修改：`tauri-agent/src-tauri/src/commands/providers.rs` —— 加 `list_models_global` command。
- 修改：`tauri-agent/src-tauri/src/lib.rs` —— 注册新 command。
- 修改：`tauri-agent/src/lib/pi.ts` —— 加 `listModelsGlobal()` 封装。
- 修改：前端模型选择器 `tauri-agent/src/features/chat/input/actions/ModelAction.tsx` —— 无项目时调 `listModelsGlobal`。

---

## 任务 1：`collectModels` 纯逻辑 + 测试

**文件：**
- 创建：`cli/src/probe-models.ts`
- 测试：`cli/src/probe-models.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// cli/src/probe-models.test.ts
import { describe, expect, it } from "vitest";
import { collectModels, type RegistryLike } from "./probe-models.js";

describe("collectModels", () => {
  it("maps registry models to serializable rows", () => {
    const registry: RegistryLike = {
      getAllModels: () => [
        {
          provider: "anthropic",
          id: "claude-sonnet-4",
          name: "Claude 4 Sonnet",
          contextWindow: 200000,
          maxTokens: 16384,
          reasoning: false,
          input: ["text", "image"],
          cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    };
    expect(collectModels(registry)).toEqual([
      {
        provider: "anthropic",
        id: "claude-sonnet-4",
        name: "Claude 4 Sonnet",
        contextWindow: 200000,
        maxTokens: 16384,
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
  });

  it("returns [] when registry has no models", () => {
    expect(collectModels({ getAllModels: () => [] })).toEqual([]);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd cli && npx vitest run src/probe-models.test.ts`
预期：FAIL，报 "Cannot find module './probe-models.js'"。

- [ ] **步骤 3：编写最少实现**

```ts
// cli/src/probe-models.ts
// 一次性子命令：列出 ModelRegistry 解析后的模型（不起 RPC 运行时、不要 workspace）。
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

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

export interface RegistryLike {
  getAllModels: () => Array<Partial<ModelRow> & { provider: string; id: string }>;
}

export function collectModels(registry: RegistryLike): ModelRow[] {
  return registry.getAllModels().map((m) => ({
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
    const authStorage = AuthStorage.create();
    const registry = ModelRegistry.create(authStorage) as unknown as RegistryLike;
    process.stdout.write(`${JSON.stringify({ ok: true, models: collectModels(registry) })}\n`);
  } catch (e) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, models: [], error: e instanceof Error ? e.message : String(e) })}\n`,
    );
  }
}
```

> 注：`ModelRegistry` 的实际列模型方法名以上游 d.ts 为准（`getAllModels` 为预期名；若上游为 `list()`/`getModels()`，在 `runModelProbe` 里适配，`collectModels` 的 `RegistryLike` 契约不变）。实现前用 `grep -r "getAllModels\|getModels\|listModels" cli/node_modules/.../model-registry.d.ts` 确认。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd cli && npx vitest run src/probe-models.test.ts`
预期：PASS（2 passed）。

- [ ] **步骤 5：Commit**

```bash
git add cli/src/probe-models.ts cli/src/probe-models.test.ts
git commit -m "feat(sp1): collectModels + probe-models entry"
```

## 任务 2：接入 sidecar 子命令

**文件：**
- 修改：`cli/src/main.ts:115`（`probe-mcp` 分支附近）

- [ ] **步骤 1：加 `probe-models` 分支**

在 `cli/src/main.ts` 的 `if (argv[0] === "probe-mcp") {...}` 之后插入：

```ts
  if (argv[0] === "probe-models") {
    const { runModelProbe } = await import("./probe-models.js");
    await runModelProbe();
    return;
  }
```

- [ ] **步骤 2：typecheck + 构建**

运行：`cd cli && npm run typecheck && npm run build`
预期：通过，`dist/main.js` 生成。

- [ ] **步骤 3：手测子命令**

运行：`cd cli && node dist/main.js probe-models`
预期：stdout 一行 JSON，`{"ok":true,"models":[...]}`（依赖本机 `~/.pi/agent/models.json`）。

- [ ] **步骤 4：Commit**

```bash
git add cli/src/main.ts
git commit -m "feat(sp1): wire probe-models subcommand in sidecar"
```

## 任务 3：Tauri `list_models_global`

**文件：**
- 修改：`tauri-agent/src-tauri/src/commands/providers.rs`
- 修改：`tauri-agent/src-tauri/src/lib.rs`（注册）

- [ ] **步骤 1：加 command（spawn sidecar 解析 JSON）**

参考现有 `probe-mcp` 的 sidecar spawn 封装（搜 `probe-mcp` 在 Rust 侧的调用），新增：

```rust
#[derive(serde::Deserialize)]
struct ProbeModelsOut {
    ok: bool,
    #[serde(default)]
    models: Vec<serde_json::Value>,
    #[serde(default)]
    error: Option<String>,
}

/// 项目无关地列出 ModelRegistry 解析后的模型：spawn `pi probe-models`（短命进程），解析其 stdout JSON。
#[tauri::command]
pub async fn list_models_global(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let sidecar = crate::pi::sidecar::resolve_pi_binary(&app)?; // 复用现有二进制解析（与 probe-mcp 同源）
    let output = tokio::process::Command::new(sidecar)
        .arg("probe-models")
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.lines().last().unwrap_or("").trim();
    let parsed: ProbeModelsOut =
        serde_json::from_str(line).map_err(|e| format!("probe-models 输出解析失败: {e}; 原文: {line}"))?;
    if !parsed.ok {
        return Err(parsed.error.unwrap_or_else(|| "probe-models failed".into()));
    }
    Ok(parsed.models)
}
```

> 注：`resolve_pi_binary` 名称以现有 `probe-mcp` 调用处为准——实现前 `grep -rn "probe-mcp" tauri-agent/src-tauri/src` 找到二进制解析与 spawn 的现成 helper 并复用，不要重写。

- [ ] **步骤 2：注册 command**

在 `tauri-agent/src-tauri/src/lib.rs` 的 `invoke_handler![...]` 列表加 `commands::providers::list_models_global`。

- [ ] **步骤 3：编译 + 单测**

运行：`cd tauri-agent/src-tauri && cargo build`
预期：通过。

- [ ] **步骤 4：Commit**

```bash
git add tauri-agent/src-tauri/src/commands/providers.rs tauri-agent/src-tauri/src/lib.rs
git commit -m "feat(sp1): add list_models_global tauri command"
```

## 任务 4：前端选择器无项目可用

**文件：**
- 修改：`tauri-agent/src/lib/pi.ts`
- 修改：`tauri-agent/src/features/chat/input/actions/ModelAction.tsx`

- [ ] **步骤 1：加封装**

在 `tauri-agent/src/lib/pi.ts` 加：

```ts
  listModelsGlobal: () => invoke<unknown[]>('list_models_global'),
```

- [ ] **步骤 2：选择器无项目时走 global**

在 `ModelAction.tsx` 取模型处：当无活动 workspace 时调 `pi.listModelsGlobal()`，否则保持现有 `pi.getAvailableModels(workspace)`。

- [ ] **步骤 3：前端类型检查 + 测试**

运行：`cd tauri-agent && npx tsc --noEmit && npm run test`
预期：通过。

- [ ] **步骤 4：Commit**

```bash
git add tauri-agent/src/lib/pi.ts tauri-agent/src/features/chat/input/actions/ModelAction.tsx
git commit -m "feat(sp1): model picker uses global list when no project open"
```

---

## 自检

- 规格覆盖：probe-models 子命令（任务 1-2）✓、list_models_global（任务 3）✓、前端无项目可用（任务 4）✓、降级回退在任务 3 的 `parsed.ok` 分支 + 前端保留 `fetch_provider_models` 路径。
- 占位符：无 TODO/待定；`getAllModels`/`resolve_pi_binary` 两处标注"以现有代码为准"并给出确认命令，非占位。
- 类型一致：`ModelRow`/`RegistryLike`（任务1）→ `ProbeModelsOut.models: Vec<Value>`（任务3，宽松透传）→ 前端 `unknown[]`，一致。
