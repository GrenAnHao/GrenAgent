# UI 完整历史持久化（auto-compaction 下保留完整对话）实现计划

> **面向 AI 代理的工作者：** 用 subagent-driven-development 或 executing-plans 逐任务实现。步骤用复选框（`- [ ]`）跟踪。

**背景 / 根因：** pi 后端默认开启自动上下文压缩（auto-compaction），上下文超限时会**物理压缩会话**（`agent_get_messages` 返回的历史变短）。前端 `loadMessages` 在切会话 / rewind / 重载（含 dev HMR、窗口重新聚焦）时用 `getMessages` 结果**整体覆盖** `store.messages`，于是压缩后的短历史盖掉了前端已积累的完整历史 → 用户「早期内容丢失」。前端 reducer（`applyEvent`）本身不删消息，问题在「后端压缩 + 前端被短历史覆盖」。

**目标：** 保留 auto-compaction（模型上下文照压、防超限），但 **UI 显示完整历史**——前端建立按会话持久化的「UI 完整历史」，作为 UI 显示的权威来源，不再被压缩后的短历史覆盖。

**关键决策（已与用户确认）：**
- 存储位置：**Tauri 磁盘文件**，每会话一个 `.pi/ui-history/<sessionKey>.jsonl`（跨重启持久、可备份/清理、无容量顾虑）。
- 权威源：**前端流式积累的 `state.messages`**（reducer 全程不删，天然完整）。每轮结束覆盖写盘。
- 加载：`loadMessages` / `showCachedSession` **优先读 ui-history**；`getMessages` 仅在 ui-history 为空（首次）时用于初始化。
- pi 的压缩摘要消息**不进** ui-history（UI 保留原始完整历史，摘要只服务模型上下文）。

**明确的限制（写入验收说明，非缺陷）：**
- 只保护**今后**：对「本次改动前就已被压缩删除」的历史无法恢复（数据已不在当前会话分支）。
- 多窗口/多设备同开同一会话：两端各自写盘，后写覆盖先写（MVP 不做冲突合并，作为已知限制）。

**技术栈：** Rust（Tauri command）+ TypeScript + zustand + vitest；包管理 bun。
测试：`cd tauri-agent && bunx vitest run <file>`（前端）、`cd tauri-agent/src-tauri && cargo test <name>`（Rust）。
类型检查：`cd tauri-agent && npx tsc --noEmit`。

---

## 文件结构

| 文件 | 职责 | 动作 |
|------|------|------|
| `tauri-agent/src-tauri/src/commands/ui_history.rs` | 读 / 覆盖写 / 删除 每会话 ui-history 文件（`.pi/ui-history/<key>.jsonl`） | 创建 |
| `tauri-agent/src-tauri/src/commands/mod.rs` | 导出 ui_history 命令 | 修改 |
| `tauri-agent/src-tauri/src/lib.rs` | `invoke_handler` 注册三个命令 | 修改 |
| `tauri-agent/src/lib/pi.ts` | 加 `readUiHistory` / `writeUiHistory` / `deleteUiHistory` 封装 | 修改 |
| `tauri-agent/src/lib/uiHistory.ts` | ChatMessage 序列化/反序列化 + sessionKey 派生（纯函数，可单测） | 创建 |
| `tauri-agent/src/lib/uiHistory.test.ts` | 序列化/反序列化/key 派生单测 | 创建 |
| `tauri-agent/src/stores/agent.ts` | flush 每轮结束写盘；loadMessages/showCachedSession 优先 ui-history | 修改 |
| `tauri-agent/src/stores/agent.test.ts` | 覆盖：ui-history 优先、短历史不覆盖、首次初始化 | 修改 |

---

## 数据格式

- 文件：`<workspace>/.pi/ui-history/<sessionKey>.jsonl`，`sessionKey` = `sessionPath` 的 basename 去扩展名（与 pi 会话文件一一对应；纯函数派生便于单测）。
- 内容：每行一条 `ChatMessage` 的 JSON（前端渲染格式，加载即用，无需再走 `messagesFromAgent`）。
- 读回时**重新分配 id**（`sa-`/`h-` 前缀 + 序号），避免存盘旧 id 与运行时 `nextId()` 冲突（对齐 `messagesFromTranscript` 的做法）。

---

## 任务 1：Tauri 命令 —— 读/写/删 ui-history 文件

**文件：** 创建 `commands/ui_history.rs`；改 `commands/mod.rs`、`lib.rs`。

- [ ] **步骤 1：实现命令**

`ui_history.rs`：
- `ui_history_read(workspace, session_key) -> Result<String, String>`：读 `.pi/ui-history/<key>.jsonl` 全文；文件不存在返回空串（非错误）。
- `ui_history_write(workspace, session_key, content) -> Result<(), String>`：确保目录存在，覆盖写（原子：写临时文件后 rename，避免半写）。
- `ui_history_delete(workspace, session_key) -> Result<(), String>`：删文件（不存在忽略）。
- 复用 `resolve_workspace_dir`（见 `commands/sessions.rs`）解析 `.pi` 目录；`session_key` 做基本清洗（禁止 `/`、`\`、`..`，防目录穿越）。

`mod.rs` 导出；`lib.rs` 的 `invoke_handler![]` 注册三命令。

- [ ] **步骤 2：Rust 测试**

`#[cfg(test)]`：写后读回一致；不存在读回空串；delete 后读回空串；`session_key` 含 `..`/分隔符被拒或清洗。
运行：`cd tauri-agent/src-tauri && cargo test ui_history`

- [ ] **步骤 3：Commit** `feat(history): tauri commands to persist per-session UI history`

---

## 任务 2：前端 pi 封装 + uiHistory 纯函数

**文件：** 改 `lib/pi.ts`；创建 `lib/uiHistory.ts` + `.test.ts`。

- [ ] **步骤 1：先写失败测试**（`uiHistory.test.ts`）

覆盖：
- `sessionKeyFromPath('/a/b/.pi/sessions/2026x.jsonl')` → `'2026x'`；空/`null` → `null`。
- `serializeHistory(messages)` → jsonl 字符串；`deserializeHistory(jsonl)` 往返得到等价 messages（id 重分配、其余字段一致）。
- 反序列化跳过坏行（fail-soft）。

- [ ] **步骤 2：实现**

`pi.ts` 加：
```ts
readUiHistory: (workspace: string, sessionKey: string) =>
  invoke<string>('ui_history_read', { workspace, sessionKey }),
writeUiHistory: (workspace: string, sessionKey: string, content: string) =>
  invoke<void>('ui_history_write', { workspace, sessionKey, content }),
deleteUiHistory: (workspace: string, sessionKey: string) =>
  invoke<void>('ui_history_delete', { workspace, sessionKey }),
```

`uiHistory.ts`：`sessionKeyFromPath`、`serializeHistory(ChatMessage[]): string`、`deserializeHistory(string): ChatMessage[]`（每行 `JSON.parse`，`try/catch` 跳过坏行，id 重分配）。

- [ ] **步骤 3：测试通过 + Commit** `feat(history): frontend ui-history serialize helpers and pi bindings`

---

## 任务 3：agent store 集成（核心）

**文件：** 改 `stores/agent.ts` + `agent.test.ts`。

- [ ] **步骤 1：写盘（flush 每轮结束）**

在 `flush()` 的 `reachedEnd` 分支（已有 `setCachedSession`）旁，若 `loadedSessionPath != null`，异步把 `state.messages` 覆盖写 ui-history：
```ts
if (loadedSessionPath) {
  const key = sessionKeyFromPath(loadedSessionPath);
  if (key) void pi.writeUiHistory(workspace, key, serializeHistory(state.messages)).catch(() => {});
}
```
（fire-and-forget，失败静默；写的是前端完整 `state.messages`，reducer 不删故完整。）

- [ ] **步骤 2：加载优先 ui-history**

改 `loadMessages`：在用 `getMessages` 结果前，先尝试读 ui-history：
- 若 ui-history 非空 → 用它作为 `processed`（UI 权威完整历史），**忽略更短的 `getMessages`**；
- 若 ui-history 为空（首次）→ 沿用 `getMessages`（`messagesFromAgent`）并**立即写一份** ui-history 初始化。
- `excluded` 仍从 `getMessages`（后端权威）重建。

因 `loadMessages` 目前是同步、被 `await pi.getMessages` 之后调用，读 ui-history 需 async。方案：把「读 ui-history」提到 `App.tsx` 调用点（与 `getMessages` 并行 await），把结果作为新选项 `uiHistory?: ChatMessage[]` 传入 `loadMessages`；`loadMessages` 逻辑改为「uiHistory 更完整则用之」。保持 `loadMessages` 纯同步、可测。

- [ ] **步骤 3：showCachedSession 一致**

内存缓存命中时也不受影响（缓存本就是前端完整历史）；未命中时走 App.tsx 的 ui-history 读取路径。确认切回不被短历史覆盖。

- [ ] **步骤 4：App.tsx 接线**

在 `getMessages` 前后并行 `pi.readUiHistory(workspace, sessionKeyFromPath(path))`，`deserializeHistory` 后作为 `uiHistory` 传给 `store.loadMessages(messages, { force, sessionPath: path, uiHistory })`（三处 getMessages 调用点统一）。

- [ ] **步骤 5：测试**

`agent.test.ts` 增：
- ui-history 比 getMessages 长（模拟压缩）→ 加载后 `messages` = ui-history，不被覆盖。
- ui-history 空 → 用 getMessages 初始化。
- flush 到 reachedEnd → 调用 `pi.writeUiHistory`（spy）。

运行：`cd tauri-agent && bunx vitest run src/stores/agent.test.ts`

- [ ] **步骤 6：Commit** `feat(history): UI shows full history, immune to backend compaction`

---

## 任务 4：清理与边界

- [ ] 会话删除时删对应 ui-history（找删除会话入口，调 `pi.deleteUiHistory`）。
- [ ] `sessionKey` 清洗防目录穿越（任务 1 已含，复核）。
- [ ] 首次打开已压缩的历史会话：ui-history 空 → 初始化为压缩后的短历史（已知限制，验收说明里写清）。
- [ ] 写盘节流：仅 `reachedEnd` 写（非每 token），已满足；如整段过大再考虑增量 append（记为 follow-up，不在本次）。

---

## 任务 5：全量校验 + 手动验收

- [ ] `cd tauri-agent && npx tsc --noEmit && bunx vitest run`
- [ ] `cd tauri-agent/src-tauri && cargo test`
- [ ] 手动（`bun run dev`）：跑一个长对话触发 auto-compaction（或手动 `/compact`）→ 切走再切回 → 早期内容仍在；重启 app → 早期内容仍在；`.pi/ui-history/` 下有对应 jsonl。

---

## 自检

- **根因对齐：** 压缩发生在 pi 后端、前端被短历史覆盖 → 本方案让 UI 有独立完整源、加载不被短历史覆盖（任务 3）。
- **auto-compaction 不动：** 模型上下文仍压缩防超限，仅 UI 显示层解耦。
- **可测性：** 序列化/key 派生纯函数（任务 2）、store 合并逻辑同步可测（任务 3）、Rust 文件 IO 有测试（任务 1）。
- **边界：** 首次已压缩会话不可恢复、多窗口冲突——均为已知限制并写入验收说明。
