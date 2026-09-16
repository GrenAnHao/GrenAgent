# 零 fork 改造总览设计（GrenAgent on Pi）

- 日期：2026-06-26
- 状态：设计草案（brainstorming 产出），待逐子项目审查 → writing-plans
- 范围：本文是**总览**。盘点 GrenAgent 当前在 Pi 运行时上的痛点，确立"零 fork"总方针，拆成 6 个独立子项目，各自有独立 spec → 计划 → 实现周期。

## 1. 背景与核心结论

GrenAgent = Tauri 桌面壳（`tauri-agent/`）+ sidecar（`cli/`，`grenagent-agent-sidecar`）+ 内置扩展（`extensions/`，37 个）+ 上游运行时 `@earendil-works/pi-coding-agent`（npm 包，仓库无 `pi/` fork）。

用户痛点：为兼容上游更新，许多功能做成半实现；并存在"必须建项目才能拿模型""伪对话"等集成硬伤。

**核心结论（经 0.79.10 实地核验）**：当初判定"够不到、只能近似"的能力，上游 **0.79.10 已开放对应扩展钩子且返回值被运行时应用**（见 §3）。因此全部 must-have **无一需要 fork**。fork 唯一独占的是第三层"深度重写 agent 内核架构"，当前无此需求。

> 决策记录：曾评估"整仓 fork（方案 C）"，但核验发现 fork 非必需，且会把"追上游"从偶发痛点变成永久维护税——正好放大用户最初的核心痛点。故定方针为**零 fork**，`pi-coding-agent`/`pi-ai`/`pi-tui` 继续吃 npm 上游，白嫖高频 provider/渲染修复。

## 2. 三层可达性矩阵（决策依据）

| 层 | 含义 | 落点 | 是否需 fork |
| --- | --- | --- | --- |
| 第一层 | 纯扩展 hook 可达 | `context`/`tool_result`/`tool_call`/`message_end`/`before_provider_request`/`session_before_compact`/`registerProvider(streamSimple)` 等 | 否 |
| 第二层 | GrenAgent sidecar/集成层可达 | 新子命令（probe/oneshot）、ACP adapter 驱动 SDK、prewarm、沙箱 ExecutionEnv、config 侧信道控制面 | 否 |
| 第三层 | 真探不到 | 改 agent loop 控制流/调度/重试、核心数据模型与会话存储语义、Pi 原生新传输模式、Rust native core | 是（或上游 PR） |

当前所有 must-have 落在第一、二层。第三层列为非目标，真撞到再针对性 fork 单点。

## 3. 钩子可达性核实（上游 0.79.10）

- `pi-coding-agent/dist/core/extensions/types.d.ts`：`on("context", …ContextEventResult{messages?})`（:827）、`on("tool_result", …ToolResultEventResult{content?,details?,isError?})`（:844）、`on("session_before_compact", …{cancel?,compaction?})`（:822）、`on("message_end", …{message?})`、`registerProvider(…streamSimple?)`（:954/983）。
- `pi-coding-agent/dist/core/extensions/runner.js`：context → `currentMessages = handlerResult.messages`；tool_result → `currentEvent.content/details/isError = handlerResult.*`；二者均与运行模式无关，跑在 AgentSession 的 agent loop，**必跨 sidecar RPC 生效**。
- `pi-ai/dist/stream.d.ts`：`streamSimple()` / `completeSimple()` 导出（SP-2 用）。

## 4. 子项目拆分

| 编号 | 子项目 | spec | 层 | 依赖 | ROI |
| --- | --- | --- | --- | --- | --- |
| SP-1 | 模型去进程化 | `2026-06-26-model-deprocess-design.md` | 二 | 无 | 高 |
| SP-2 | 一次性 LLM 统一 | `2026-06-26-oneshot-llm-design.md` | 二 | 无 | 高 |
| SP-3 | 真对话模式（项目无关常驻对话） | `2026-06-26-real-chat-mode-design.md` | 二 | 受益于 SP-1 | 高 |
| SP-4 | 真控制面（去伪对话） | `2026-06-26-real-control-plane-design.md` | 二 | 无 | 中高 |
| SP-5 | after-tool 写后回灌 | `2026-06-26-after-tool-feedback-design.md` | 一 | 无（复用 diagnostics/lsp） | 高 |
| SP-6 | 上下文控制（回退/删段/压缩可控） | `2026-06-26-context-control-design.md` | 一 | 无 | 中高 |

## 5. 依赖与建议顺序

```
SP-1 ──▶ SP-3              (SP-1 让 SP-3 的模型选择器无项目即可用)
SP-2 · SP-4 · SP-5 · SP-6   (互相独立，可并行/任意顺序)
```

- 小而快先收：SP-1 / SP-2 / SP-4。
- 纯扩展、故障隔离最好：SP-5 / SP-6。
- 用户最看重、含 UI：SP-3（接在 SP-1 后）。

## 6. 上游同步策略

- `pi-coding-agent` / `pi-ai` / `pi-tui`：保持 npm 版本区间 pin，随时升级，**零 fork 维护税**。
- 任何"加个钩子"的 additive 需求 → 向上游提 PR（社区 PR 活跃）当压力阀，而非自维护 fork。
- 真撞到第三层（如换 agent loop 架构）→ 才针对性 fork 单包单点，独立排期。

## 7. 横切关注点

- **持久化**：状态统一落 `.pi/`；排除集/模式/审批用 `appendEntry`（树感知）或 runtime-config（热更新）。
- **降级**：全部 fail-soft；外部依赖（诊断/LSP/oneshot/provider）缺失不阻断主流程。
- **模式适配**：涉及 `ctx.ui.*` 的用 `ctx.hasUI`/`ctx.mode` 判断；RPC 经 `extension_ui` 子协议，print/json 降级静默。
- **安全**：新增执行类能力继承 `safety`/`mcp-policy` 约束。

## 8. 非目标

第三层全部：改 agent loop 控制流/调度/重试、物理改写磁盘会话历史、Pi 原生新传输模式、Rust native core。ACP 若需要，走第二层 sidecar adapter，不 fork。
