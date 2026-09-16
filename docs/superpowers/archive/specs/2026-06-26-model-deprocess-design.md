# SP-1 模型去进程化设计（probe-models）

- 日期：2026-06-26
- 状态：设计草案（brainstorming 产出），待审查 → writing-plans
- 范围：让"列出运行时解析后的模型"**不再依赖打开项目/起 pi 进程**。零 fork，sidecar 子命令 + 薄 Tauri/前端接线。
- 所属：零 fork 6 子项目之 SP-1（总览见 `2026-06-26-zero-fork-roadmap-design.md`）。

## 1. 背景与目标

痛点（用户原话）：「必须创建项目才能获取模型，非常奇怪」。

根因：`PiManager`（`tauri-agent/src-tauri/src/pi/manager.rs:11`）是 `workspace → pi 进程` 一一映射，`ModelRegistry` 绑在每个进程里。`agent_get_available_models`（`tauri-agent/src-tauri/src/commands/agent.rs:316`）必须 `send(&mgr, &workspace, GetAvailableModels)`——没开项目就没进程，就拿不到 Pi 口径的模型表（含 contextWindow/cost/能力等元数据）。

现有 `fetch_provider_models`（`tauri-agent/src-tauri/src/commands/providers.rs:218`）只是 Rust 直接打供应商 `/models` HTTP 列 id，**无 Pi 元数据、不经 ModelRegistry 合并 models.json**，仅够"测试连接"用。

目标：提供一个**项目无关**的模型枚举入口，给全局设置页、冷启动、SP-3 真对话模式的模型选择器使用。

## 2. 现状核验（锚点）

- `manager.rs:11` `PiManager`（workspace→client 映射）。
- `agent.rs:316` `agent_get_available_models` 走 `send(&mgr,&workspace,…)`，强依赖 workspace 进程。
- `providers.rs:218` `fetch_provider_models`（raw HTTP，无元数据）。
- `cli/src/main.ts:115` 已有 `probe-mcp` 子命令先例：`if (argv[0] === "probe-mcp") { runProbeCli(); return; }`——**不启动 pi 运行时**，独立短命。
- `cli/src/main.ts:13-24` 已 import `AuthStorage`、`ModelRegistry`。
- 上游 `pi-coding-agent/dist/cli/list-models.js` 存在——模型枚举本就是 CLI 既有能力。

## 3. 设计

### 3.1 sidecar 子命令 `probe-models`

仿 `probe-mcp`（`extensions/mcp/probe.ts:47` `runProbeCli` 同款形态）：

- 入口：`cli/src/main.ts` 加 `if (argv[0] === "probe-models") { await runModelProbe(); return; }`（在 `isRpcMode` 判断之前，纯一次性、不起运行时）。
- 实现：`AuthStorage.create()` → `ModelRegistry.create(authStorage)` → 列出已解析模型（id / provider / name / contextWindow / maxTokens / cost / input 能力 / reasoning）→ `process.stdout.write(JSON.stringify(models) + "\n")`。诊断走 stderr。
- 读配置：`~/.pi/agent/models.json` + `auth.json` 本就全局，ModelRegistry 自行读取；无需 cwd。

### 3.2 Tauri 命令 `list_models_global`

- 新 `#[tauri::command] list_models_global()`：spawn `binaries/pi probe-models`（短命进程），读 stdout 解析 JSON 返回。
- 复用现有 sidecar 解析路径（参考 `probe-mcp` 的 spawn 封装）。

### 3.3 前端

- 模型选择器（`tauri-agent/src/features/chat/input/actions/ModelAction.tsx`）：未开项目/全局设置时调 `list_models_global`；in-session 仍可用既有 `agent_get_available_models`（或统一切到 global，二者数据同源）。

## 4. 数据流

```
设置页/冷启动/对话模式 ──list_models_global()──▶ spawn `pi probe-models`
  → AuthStorage + ModelRegistry（读全局 models.json/auth.json，无 session）
  → JSON(models[]) ──▶ Tauri 解析 ──▶ 前端选择器
```

## 5. 错误处理 / 降级

- probe 进程失败/超时 → 回退 `fetch_provider_models`（raw id 列表）或返回空 + 明确提示。
- models.json/auth.json 缺失 → 返回空列表 + 引导去配置页。
- 不阻断任何主流程（纯只读枚举）。

## 6. 测试

- `runModelProbe` 在无 session 下能产出非空模型 JSON（给定测试 models.json）。
- `list_models_global` 解析 JSON、错误回退路径。
- 与 in-session `agent_get_available_models` 结果一致性（同源校验）。

## 7. 非目标

- 不改 in-session 模型切换（`agent_set_model` 等仍走 RPC）。
- 不在此处做模型健康检查（属 SP-2 / 现有 diagnose）。

## 8. MVP 与增强

- MVP：`probe-models` 子命令 + `list_models_global` + 选择器全局可用。
- 增强：probe 结果缓存（避免每次 spawn）；与 SP-3 常驻对话进程共享模型表。
