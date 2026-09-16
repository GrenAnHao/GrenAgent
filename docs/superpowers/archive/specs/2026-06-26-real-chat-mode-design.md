# SP-3 真对话模式设计（项目无关的常驻对话）

- 日期：2026-06-26
- 状态：设计草案（brainstorming 产出），待审查 → writing-plans
- 范围：提供一个**不与项目绑定、即开即聊、无延迟卡顿**的独立对话面。零 fork，PiManager 用法 + prewarm + 精简扩展集 + 前端入口。
- 所属：零 fork 6 子项目之 SP-3（受益于 SP-1 模型去进程化）。

## 1. 背景与目标

用户原话：「真对话模式 = 不要跟项目混在一起，而是单独进行对话，无延迟、卡顿」。

根因：
- `PiManager`（`tauri-agent/src-tauri/src/pi/manager.rs:11`）是 `workspace → pi 进程`，**凡对话必绑某个项目 workspace**；没有"无项目"的通用对话。
- 冷启动慢：开项目要 spawn pi 进程 + 加载 37 个扩展 + resource loader，首条消息有延迟（现有 `warm_workspace` 用 `GetState` ping 迫使扩展加载完才就绪，`agent.rs:232`）。

目标：一个常驻、即时、项目无关的"对话"面——打开 app 即可聊天，模型可选（经 SP-1），不需要先建/开项目，且无明显延迟。

## 2. 现状核验（锚点）

- `manager.rs:11` `PiManager`（workspace→client）；`get_or_open`（:25）按 key 复用/创建进程。
- `cli/src/main.ts:137` RPC 模式 `cwd = process.cwd()`；运行时按 cwd 建（`createRuntime` :78）。
- `tauri-agent/src/lib/prewarm.ts:8` `prewarmWorkspace` / `:28` `prewarmRecent`（已有后台预热，调 `pi.warmWorkspace`）。
- `cli/src/main.ts:91` `skillsOverride` + `SKILLS_DISABLED` 已实现"按配置过滤资源"的先例（同款机制可用于精简扩展集）。
- 会话存储：`~/.pi/agent/sessions/--<encoded-cwd>--/*.jsonl`（按 cwd 分区）。

## 3. 设计

### 3.1 项目无关的常驻对话进程

- `PiManager` 加一个**特殊 key**（如 `"__chat__"`），其 cwd 指向**中性目录**（如 `~/.pi/chat-scratch/` 或用户家目录），用既有 `get_or_open` 起一个常驻 pi 进程。它不属于任何项目侧栏分组。
- 会话落 `~/.pi/agent/sessions/--<chat-scratch-encoded>--/*.jsonl`，与项目会话天然隔离。

### 3.2 无延迟

- **启动即预热**：app 启动时 `prewarmWorkspace(chatScratchCwd)`（复用 `prewarm.ts`），常驻不杀，首条消息瞬发。
- **精简扩展集**：对话进程不需要 lsp/dap/code-intel/code-search/ast-tools 等重扩展；用 `SKILLS_DISABLED` 同款机制（或新增 `EXTENSIONS_PROFILE=chat`）按进程过滤，缩短加载、降低开销。保留：safety/approval/loop-guard/compaction-policy/agent-mode/long-term-memory/web-* 等对话相关。
- 流式本就走 Tauri 事件（`agent.rs` TauriSink），延迟主要来自冷启动 + 扩展数，上两招直接压掉。

### 3.3 模型可选

- 模型选择器经 SP-1 `list_models_global`，无项目即可列模型；对话进程自身亦有 ModelRegistry，`agent_set_model` 对 `__chat__` 生效。

### 3.4 前端

- 顶部/侧栏加独立「对话」入口（区别于项目会话列表），点进即用常驻 `__chat__` 进程。
- 复用现有聊天 UI（消息流/工具卡/输入框），workspace 参数固定为 `__chat__`。

## 4. 数据流

```
app 启动 ──prewarm(chatScratchCwd)──▶ 常驻 __chat__ 进程（精简扩展集，已就绪）
用户进"对话"面 ──agent_prompt(workspace="__chat__", …)──▶ 瞬时流式
模型选择 ──list_models_global()（SP-1）──▶ 选择器
```

## 5. 持久化

- 对话历史：`~/.pi/agent/sessions/--<chat-scratch>--/*.jsonl`，与项目隔离。
- 精简扩展集配置：runtime-config（`EXTENSIONS_PROFILE` 或复用 `SKILLS_DISABLED`）。

## 6. 错误处理 / 降级

- 常驻进程崩溃 → `get_or_open` 下次自动重建；prewarm 失败无害可重试（`prewarm.ts` 已 fail-soft）。
- 中性目录不可写 → 回退家目录 / 临时目录。
- 精简扩展集误删必需扩展 → 保底白名单含 safety。

## 7. 模式适配 / 安全

- `__chat__` 进程同样加载 safety/approval/loop-guard（不因"精简"丢安全闸）。
- 中性 cwd 下 bash/write/edit 的路径保护仍由 safety 生效；可对对话模式默认更保守的审批策略。

## 8. 非目标

- 不做对话与项目会话的互转/迁移（后续增强）。
- 不在对话模式启用重代码智能扩展（按需再开）。

## 9. 测试

- `__chat__` 进程在无项目下起得来、能 prompt、流式回传。
- prewarm 后首条消息延迟显著低于冷启动（基准对比）。
- 精简扩展集仍含 safety；会话隔离在独立 sessions 分区。

## 10. MVP 与增强

- MVP：`__chat__` 常驻进程 + 启动预热 + 精简扩展集 + 前端对话入口 + 模型可选（依赖 SP-1）。
- 增强：对话↔项目上下文嫁接（handoff）、多对话标签、对话模式专属审批默认。
