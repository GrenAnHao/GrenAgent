# SP-2 一次性 LLM 统一设计（oneshot）

- 日期：2026-06-26
- 状态：设计草案（brainstorming 产出），待审查 → writing-plans
- 范围：把"一次性、不进对话"的辅助 LLM 调用从 Rust 重抄实现，统一收敛到 `pi-ai` 的同一套 dispatch。零 fork，sidecar 子命令 + 删冗余 Rust。
- 所属：零 fork 6 子项目之 SP-2。

## 1. 背景与目标

根因（活标本）：`tauri-agent/src-tauri/src/commands/providers.rs` 里 `fix_mermaid_diagram`（:544）与 `diagnose_provider_model`（:877）为了做"一次性补全"，在 Rust 里把 OpenAI / Anthropic / Google 的 **HTTP 端点 + 鉴权 + SSE 解析 + usage 抽取整套又实现了一遍**（`call_llm_oneshot` :374、`diagnose_openai_stream` :647、`diagnose_anthropic_stream` :779、`diagnose_google_stream` :830，合计约 600 行）。这套与 `pi-ai` 平行，**永远享受不到上游的 provider/计费/thinking 参数修复**——正是"为兼容上游而半实现"的典型。

目标：提供一个走 `pi-ai` 的一次性调用入口，让辅助 LLM 调用（mermaid 修复、模型健康检查、未来的小工具）与正式对话**同源**，并删除 Rust 平行实现。

## 2. 现状核验（锚点）

- `providers.rs:374` `call_llm_oneshot`（Rust 重抄 4 类 api 的 POST + 抽取）。
- `providers.rs:544` `fix_mermaid_diagram`、`:877` `diagnose_provider_model`、`:647/:779/:830` 三个 `diagnose_*_stream`。
- 上游 `pi-ai/dist/stream.d.ts`：`export declare function streamSimple<TApi>(model, context, options?): AssistantMessageEventStream` 与 `completeSimple<TApi>(model, context, options?): Promise<AssistantMessage>`。
- `ModelRegistry` 解析 model（含 provider 端点/鉴权）；sidecar 已 import（`cli/src/main.ts:13`）。

## 3. 设计

### 3.1 forked 无关——sidecar 子命令 `oneshot`

- 入口：`cli/src/main.ts` 加 `if (argv[0] === "oneshot") { await runOneshot(); return; }`（一次性，不起 RPC 运行时）。
- 入参（经 env `ONESHOT_REQUEST` 或 argv，JSON）：`{ provider, modelId, system?, user, stream? }`。
- 实现：`AuthStorage.create()` → `ModelRegistry.create()` → 解析 `Model` → 构造 `Context { messages: [system?, user] }` → `stream ? streamSimple(...) : completeSimple(...)`。
  - 非流：聚合为单 JSON `{ ok, content, usage }` 打 stdout。
  - 流：逐 chunk JSONL（`{delta}` / 末 `{usage}`）打 stdout，便于 Tauri Channel 增量读（健康检查测 TTFT/速率用）。

### 3.2 Tauri 侧瘦身

- `fix_mermaid_diagram`：改为 spawn `pi oneshot`（非流，system=mermaid 修复 prompt），抽取 ```mermaid```（保留现有 `extract_mermaid` :331 纯函数）。
- `diagnose_provider_model`：改为 spawn `pi oneshot --stream`，读 JSONL 计 TTFT/total/usage/速率（保留 `DiagnoseResult` 形状）。
- **删除** `call_llm_oneshot` + `diagnose_openai_stream` + `diagnose_anthropic_stream` + `diagnose_google_stream` + `parse_id_list` 等约 600 行 Rust。`fetch_provider_models`（SP-1 降级用）可保留或一并迁 oneshot 风格（择机）。

## 4. 数据流

```
mermaid 修复 / 健康检查 ──spawn `pi oneshot`──▶ ModelRegistry 解析 model
  → pi-ai completeSimple/streamSimple（与正式对话同一 dispatch）
  → JSON / JSONL(stdout) ──▶ Tauri 解析 ──▶ 前端
```

## 5. 错误处理 / 降级

- oneshot 进程失败 → 返回结构化错误（沿用现有 `DiagnoseResult.ok=false` / mermaid 失败提示）。
- 模型/鉴权缺失 → 明确错误，不静默。
- 全程不进对话历史、不动会话。

## 6. 测试

- oneshot 非流/流两路在给定 provider 配置下产出内容与 usage。
- mermaid 修复端到端（spawn → 抽取 fenced）。
- 健康检查 TTFT/usage 解析。
- 删除 Rust 后 `cargo build`/`cargo test` 通过、无悬挂引用。

## 7. 非目标

- 不替代正式对话链路（那本就走 pi-ai）。
- 不在 oneshot 内做多轮/工具调用（保持"一次性"语义）。

## 8. MVP 与增强

- MVP：`oneshot` 子命令（流/非流）+ 改写 mermaid 修复与健康检查 + 删 Rust 平行实现。
- 增强：把 `fetch_provider_models` 也并入（列模型也走 pi-ai/ModelRegistry，与 SP-1 合流）。
