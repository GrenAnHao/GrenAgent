# 多会话同时跑 — 架构方案与文件级落地计划

> 状态：设计稿（待评审，未动工）。目标：让 tauri-agent 支持「多会话同时跑」，既覆盖**多对话/项目并行**，也覆盖**同一项目目录下多会话并发**。
> 本文档基于对现有代码的逐文件核查，给出三阶段演进路线与每一步的文件级改造清单。

---

## 0. 术语

| 词 | 含义 | 代码锚点 |
|---|---|---|
| workspace | 一个 cwd（项目目录或 `~/.pi/agent/works/<id>` 对话目录）。前端 store / 后端进程 / 会话归属的主键 | `resolve_workspace_dir` (`src-tauri/src/commands/sessions.rs:112`) |
| 会话 session | pi 的一个 `.jsonl`，header 带 `cwd`。一个 workspace 下可有多个会话 | `parse_session_header` (`sessions.rs:22`) |
| pi 进程 | `pi --mode rpc` sidecar，stdio JSONL RPC，**每 workspace 一个** | `PiManager` (`src-tauri/src/pi/manager.rs:9`) |
| AgentStore | 前端 per-workspace 的消息/流式状态 zustand store | `createAgentStore` (`src/stores/agent.ts:31`) |

---

## 1. 现状（已逐文件证实）

### 1.1 后端：每 workspace 一个常驻进程，切换不杀

- `PiManager` = `HashMap<workspace, Arc<PiClient>>`，`get_or_open` 复用进程（`manager.rs:25`）。
- `spawn_pi_client` 起 `pi --mode rpc`，stdio 行式 JSONL（`pi/sidecar.rs:47`）。
- 切换项目/会话只 `openWorkspace` + `setActiveWorkspace`，**从不 close 旧 workspace**；`close_all` 仅在窗口关闭时触发（`App.tsx:265`、`lib.rs:34`）。
- **结论：后端"多进程后台并发"已经成立**，多个 workspace 的 pi 进程可同时常驻、同时跑。

### 1.2 pi 协议：单活跃会话、事件无 session_id

- 切换会话靠 `SwitchSession { sessionPath }`（`pi/types.rs:35`），即同一进程同一时刻只有一个活跃会话。
- 事件按 **workspace** 广播，envelope = `{ workspace, event }`，**不带 session 维度**（`pi/sink.rs:17`、`pi/client.rs:74`）。
- 命令全部以 `workspace` 为唯一键（`commands/agent.rs`、`lib.rs:42` invoke_handler）。
- **结论：同一 workspace(cwd) 内多个会话无法真并发**（无 session_id 无法路由事件 + 单活跃会话）。

### 1.3 前端：同一时刻只挂一个 store、只订阅一个 workspace

- `App` 只渲染一个 `<AgentStoreProvider workspace={activeWorkspace}>`（`App.tsx:488`）。
- `createAgentStore(workspace)` 在 `onPiEvent` 里 `if (env.workspace !== workspace) return`（`agent.ts:94`），切走的 workspace store 被 `destroy()`（`AgentStoreContext.tsx:30`）。
- 全局单例 store：`useSessionStore`（`store/session.ts`）、`useDockStore`（`stores/dockStore.ts`，单层 `tabs/activeByRegion`）、`useLayoutStore`。
- **结论：缺口在前端**——切走的会话流式过程丢失（store 卸载），切回靠 `getMessages` 拉最终态（`App.tsx:239`）。

### 1.4 pi 本体是外部包，但 SDK 原语已暴露

- pi = `@earendil-works/pi-coding-agent`（0.78.x）。RPC 走官方 `runRpcMode(runtime)`（**单 runtime**），但 `createAgentSessionRuntime` / `createAgentSessionServices` / `SessionManager` 已 import 可用（`cli/src/main.ts:13`、`:91`）。
- **结论：方案 D「单进程多 runtime」改的是本仓库 `cli` sidecar，不是改外部依赖**——但要自行重实现 runRpcMode 的全部能力。

---

## 2. 核心矛盾与缺口

| 诉求 | 现状能力 | 缺口 |
|---|---|---|
| 多个对话/项目 **后台并行跑** | 后端已并发；前端只挂 1 个 store | **前端多 store 常驻**（阶段 1 A） |
| 切走的会话 **不丢流式过程** | store 卸载即丢 | **store 常驻 + 后台仍消费事件**（阶段 1 A） |
| **同屏**看/操作多个会话 | 单屏单会话 | **会话作为 keep-alive tab**（阶段 2 B，复用 dockStore） |
| **同一项目目录**下多会话并发 | 单进程单活跃会话 | **per-session 进程 或 单进程多 runtime + 全链路 session_id**（阶段 3 D） |

---

## 3. 目标态架构

```
┌───────────────────────────── 前端 ─────────────────────────────┐
│  AgentStoreRegistry  (Map<key, AgentStoreApi>，常驻、后台消费)   │
│     key = 阶段1: workspace   →   阶段3: `${workspace}::${sessionId}`
│        │                                                        │
│        ├── store(A) ──┐                                         │
│        ├── store(B)   │  每个 store 独立订阅自己 key 的事件流     │
│        └── store(C) ──┘  isStreaming 后台可见（Sidebar 角标）    │
│                                                                 │
│  dockStore(per-workspace)  + region 'main' 多 session tab(阶段2) │
└─────────────────────────────────────────────────────────────────┘
        │ invoke(cmd, {workspace[, sessionId]})   ▲ pi://event {workspace[, sessionId], event}
        ▼                                         │
┌───────────────────────────── 后端 Rust ────────────────────────┐
│  PiManager: HashMap<key, Arc<PiClient>>                         │
│     阶段1/2: key=workspace（现状）                               │
│     阶段3-D1: key=workspace::sessionId（每会话一进程）           │
│     阶段3-D2: key=workspace，PiClient 内部多 session 路由        │
└─────────────────────────────────────────────────────────────────┘
        │ stdio JSONL
        ▼
   pi sidecar (cli/src/main.ts)
     阶段1/2: runRpcMode(单 runtime)
     阶段3-D2: 自建多 runtime RPC + 事件带 sessionId
```

设计原则：**key 单点抽象**。阶段 1 用 `workspace` 作 registry/manager 的 key；阶段 3 把 key 升级为 `workspace::sessionId`，前两阶段的所有代码以"key"为单位书写，阶段 3 只改 key 的构造，不重写消费方。

---

## 4. 演进路线图

| 阶段 | 解决 | 改动面 | 改 pi? | 预估 |
|---|---|---|---|---|
| **A** 前端多 store 常驻 | 多对话后台并行 + 切回不丢流式 | 纯前端（后端 0） | 否 | 2–4d |
| **B** 会话即 dock tab | 同屏多会话 | 前端（复用 dockStore） | 否 | 3–5d |
| **D1** 每会话独立进程 | 同 cwd 多会话并发（务实版） | Rust manager key + 前端 key | 否 | 2–3d |
| **D2** 单进程多 runtime | 同 cwd 多会话并发（省内存版） | 全链路 session_id + cli 重写 | 是(本仓库 cli) | 1.5–3w |

推荐：**A → B → D1**；D2 作为长期省内存演进，且优先推动 pi 上游让 `runRpcMode` 原生支持多 session。

---

## 5. 阶段 A — 前端多 store 常驻（文件级）

### A.0 关键技术坑（必须先解决）

**requestAnimationFrame 在隐藏/非激活时被浏览器节流甚至暂停**。当前 `scheduleFlush` 用 rAF 批量应用事件（`agent.ts:76`）。多 store 常驻后，**后台会话的 store 仍在收事件，但 rAF 不触发 → 流式状态不更新**，直到切回才一次性 flush（虽不丢事件，但"后台实时进度/角标"会卡住）。
- 对策：`scheduleFlush` 增加 fallback——非激活 store 用 `setTimeout(flush, ~60ms)` 兜底，激活 store 用 rAF。可给 store 加 `setActive(active: boolean)`，registry 切换时调用。

### A.1 新增 `src/stores/agentStoreRegistry.ts`

常驻注册表，持有所有 store，按 key 创建/复用/销毁。

```ts
import { createAgentStore, type AgentStoreApi } from './agent';

export interface AgentStoreRegistry {
  getOrCreate: (key: string) => AgentStoreApi;
  get: (key: string) => AgentStoreApi | undefined;
  release: (key: string) => void;        // 关闭单个会话时销毁其 store
  keys: () => string[];
  setActive: (key: string | null) => void; // 控制 rAF/setTimeout flush 策略
  destroyAll: () => void;
}

export function createAgentStoreRegistry(opts?: { max?: number }): AgentStoreRegistry {
  const map = new Map<string, AgentStoreApi>();
  // 可选 LRU：超过 opts.max 时 release 最久未 active 的 key（阶段 A 的"进程池"雏形 = 方案 E）
  ...
}
```

- key 阶段 A = `workspace`；阶段 D 升级为 `workspace::sessionId`，本文件不感知差异。
- `getOrCreate` 内部调用现有 `createAgentStore(workspace)`（`agent.ts:31`，已自带订阅 + destroy）。

测试：`agentStoreRegistry.test.ts`（复用/release/LRU/destroyAll）。

### A.2 改 `src/stores/AgentStoreContext.tsx`

当前：`useMemo(() => createAgentStore(workspace), [workspace])` + 卸载即 `destroy()`（`:23`、`:30-32`）——**这是"单 store"的根源**。

改为两层：
- 顶层新增 `AgentRegistryProvider`：`createAgentStoreRegistry()` 一次，放 context，`destroyAll` 仅在 App 卸载时。
- `AgentStoreProvider workspace={active}`：改为 `registry.getOrCreate(workspace)` 取 store；**不再在 workspace 切换时 destroy**；切换时 `registry.setActive(workspace)`。
- `useAgentStoreContext()` 签名不变（消费方 35 处零改动）。
- 新增 `useAgentStoreFor(key)`：供阶段 B 的 SessionBody 拿任意会话的 store。

### A.3 改 `src/stores/agent.ts`

- `scheduleFlush`/`flush` 增加 `active` 标志与 setTimeout fallback（见 A.0）。
- `AgentStoreApi` 增加 `setActive(active: boolean)`。
- 其余不变（订阅/destroy 已具备）。

### A.4 改 `src/App.tsx`

- `App()`：用 `<AgentRegistryProvider>` 包住 `<AgentStoreProvider>`（`:484-492`）。
- 删除 `:479-481` 的 `closeWorkspace(active)`（改由 registry/后端 close_all 统一收口；保活的 workspace 不应在 cleanup 误杀）。
- `Workspace()` 的 dock reset effect（`:188-194`）见 A.6 决策。
- 维护"已打开 workspace 集合"：把 `handleOpenSession`/`switchProject`/`handleNewConversation`（`:265-343`）打开过的 workspace 注册进 registry（保活），并 `openWorkspace` 确保后端进程在。

### A.5 改 `src/features/sessions/Sidebar.tsx` + `SessionItem.tsx`

- 后台运行角标：从 `registry.keys()` 各 store 的 `isStreaming` 渲染"运行中"圆点（区别于当前仅 `runningSessionPath` 单值，`App.tsx` 传入）。
- 点击切换 = `setActive` + 显示对应 store；后台会话继续跑。

### A.6 dockStore 的 per-workspace 决策（二选一）

`useDockStore` 是全局单例（终端/page/subagent 跟随 active workspace，靠 `resetWorkspaceTabs` 在切换时重置，`dockStore.ts:228`、`App.tsx:192`）。多 store 常驻后：
- **A6-甲（省力，阶段 A 默认）**：dock 仍只服务 active workspace，切换时按现状 reset。后台会话的终端/子代理 tab 不常驻（功能不退化于今天）。
- **A6-乙（彻底）**：dockStore 改为 `byWorkspace: Record<workspace, { tabs, activeByRegion }>`，所有 action 带 workspace 维度；persist 分 workspace。终端/子代理随会话常驻。**建议放到阶段 B 一起做**（B 本就要深改 dockStore）。

> 推荐：阶段 A 采 A6-甲，把 dock per-workspace 化与阶段 B 合并，降低单步风险。

### A.7 阶段 A 验收

- 会话 X 发起长任务 → 切到会话 Y → X 后台继续跑，Sidebar X 显示运行角标 → 切回 X，流式过程连续可见（不再只看到最终态）。
- 单测：registry；agent.ts 的后台 flush fallback。

---

## 6. 阶段 B — 会话作为 dock keep-alive tab（同屏，文件级）

复用刚落地的 dockStore Tab 容器（`dockStore.ts` / `features/dock/*`），把"会话"做成第三类可并存内容。

### B.1 改 `src/stores/dockStore.ts`

- `DockTabKind` 增加 `'session'`；`DockRegion` 增加 `'main'`（主聊天区纳入 dock）。
- 新增 `SessionPayload { workspace: string; sessionPath: string }`，并入 `DockTabPayload`。
- 新增 action `openSession({ workspace, sessionPath, title })`：在 `main` region 加/激活 session tab（去重 by `session:${workspace}:${sessionPath}`）。
- 落地 A6-乙：state 升级为 `byWorkspace`（若阶段 A 未做）。

### B.2 新增 `src/features/dock/SessionBody.tsx`

```tsx
// 用 registry 拿该会话的常驻 store，包一层 Provider 复用现有 ChatView
export function SessionBody({ tab }: DockBodyProps) {
  const { workspace } = tab.payload as SessionPayload;
  return (
    <AgentStoreScope workspace={workspace}>
      <ChatView />
    </AgentStoreScope>
  );
}
```

- `ChatView` 已从 `useAgentStoreContext()` 取 workspace+store（`ChatView.tsx:8`），**零改动**即可复用；只需 `AgentStoreScope` 用 `registry.getOrCreate(workspace)` 提供 context。

### B.3 改 `src/features/dock/TabBodyRenderer.tsx`

- `BODY_RENDERERS` 注册 `session: SessionBody`。

### B.4 改 `src/App.tsx`

- `MainChatColumn`（`:106-115`）改为渲染 `main` region 的多 session tab（TabStrip + TabBodyStack），或新增 `MainDockColumn`。
- 打开会话从 `handleOpenSession` 改为 `dockStore.openSession(...)`（多开并存而非替换）。

### B.5 验收

- 同屏并排/分 tab 显示多个会话，各自独立流式；DnD/keep-alive 复用现有框架；终端/子代理随会话切换正确（依赖 A6-乙）。

---

## 7. 阶段 D — 同一项目目录多会话并发（协议 + 文件级）

> 仅当出现「同一项目目录下多会话必须同时跑」硬需求时启动。先做 D1（务实），D2 视内存压力再上。

### D1 — 每会话独立进程（推荐先行）

思路：把 registry/manager 的 key 从 `workspace` 升级为 `workspace::sessionId`，同 cwd 多会话 = 同 cwd 多 pi 进程。复用阶段 A 已验证的多进程模型，**不改 pi、不改协议**。

- 后端 `src-tauri/src/pi/manager.rs`：`HashMap` key 用复合键（新增 `open(workspace, session_id)`；或包一层 `SessionKey`）。
- 后端 `commands/agent.rs` 等：命令新增可选 `session_id`，与 workspace 合成 key 取 client（`client_for`，`agent.rs:17`）。
- 后端 `pi/sink.rs` + `client.rs`：envelope 加 `session_id`（透传 key 的 session 部分），供前端区分（`sink.rs:17`、`client.rs:74`）。
- 前端 `lib/pi.ts`：invoke 与 `PiEventEnvelope` 加 `sessionId`；registry key = `${workspace}::${sessionId}`。
- 代价/验证点：① 同 cwd N 进程内存 ×N（用 A.1 的 LRU/进程池 = 方案 E 约束）；② 同 cwd 多进程安全性。
- **spike 已验证（2026-06-14，读 pi main `session-manager.ts`）**：pi `SessionManager` **无任何文件锁**（纯 `appendFileSync`/`writeFileSync`/`openSync`，Issue #2616 自述"lacked concurrent process safety"；OpenClaw 那个 process-aware 锁是 OpenClaw 自加，非 pi 自带）。结论：
  - **session 文件无需自加锁**——D1 每会话独立进程各绑不同 `sessionFile`，守住"一 sessionFile 一进程"（manager key 去重）即无并发写冲突；首次落盘 `openSync(file,"wx")` 排他创建对首次抢占有兜底。
  - **延迟落盘**：新 session 首个 assistant 响应前不创建文件 → 起进程→`switchSession` 不留空 jsonl，**无需 `--session` 启动参数**。
  - **真正风险（需设计）**：① 多 app 实例对同一 file 无跨进程锁（边缘场景，加 app 级单例 lockfile 可选）；② **cwd 级 `.pi/` 共享资源（checkpoint git / kb sqlite / memory）**同 cwd 多进程并发写——比 session 文件更现实，须由"单一 cwd 主进程"提供或加协调。

### D2 — 单进程多 runtime（省内存，长期）

思路：改 `cli/src/main.ts`，弃用 `runRpcMode`，用 SDK 自建多 runtime RPC server。

- `cli/src/main.ts`（`:91-99`）：维护 `Map<sessionId, AgentSessionRuntime>`；读 stdin JSONL → 按 `sessionId` 路由到对应 runtime；runtime 事件输出时注入 `sessionId`。**需自行重实现 runRpcMode 内置的能力**：prompt/steer/followUp/abort/queue/compaction/fork/clone/setModel/thinking/auto-retry…（这是 D2 的主要风险与工作量）。
- 后端全链路加 `session_id`：`pi/types.rs`（PiOutbound 各 variant + PiInbound 解析）、`pi/client.rs`（事件路由）、`pi/sink.rs`（envelope）、`commands/agent.rs`（命令签名）。`manager.rs` 仍 per-cwd 单进程。
- 前端：`lib/pi.ts`（invoke + envelope 加 sessionId）、`stores/agent.ts`（订阅按 `${workspace}::${sessionId}` 过滤，`agent.ts:94`）、registry key。
- 强烈建议：先给 pi 上游提需求/PR 让 `runRpcMode` 原生支持多 session，避免长期维护自建多路复用分叉。

### D 阶段统一收益

- registry/manager 的"key 单点抽象"（见 §3）使 D1↔D2 切换对 UI 透明：UI 只认 `key`，底层是"多进程"还是"单进程多 runtime"可替换。

---

## 8. 风险与对策

| 风险 | 阶段 | 对策 |
|---|---|---|
| rAF 后台节流导致后台会话不更新 | A | `scheduleFlush` setTimeout fallback（A.0） |
| 常驻 store/进程内存无上限 | A/D1 | registry LRU + 进程数上限（方案 E 雏形，A.1 内置） |
| dock 全局单例与多 store 串台 | A/B | A6 决策：A 采甲、B 落乙（per-workspace dock） |
| 同 cwd 多进程文件串扰 | D1 | 先 spike 验证 pi 同 cwd 并发安全 |
| 自建多路复用漏实现 pi 能力 | D2 | 优先推动上游；自建则逐能力对齐 + 回归 |
| 事件顺序/丢失 | D2 | 保留现有 `JsonlBuffer` 行式切分；按 sessionId 分流后各自有序 |

---

## 9. 测试策略

- 单测：`agentStoreRegistry.test.ts`；`agent.ts` 后台 flush fallback；`dockStore` 新增 `openSession`/`byWorkspace`（沿用 `dockStore.test.ts` 风格）。
- Rust 单测：D 阶段 `manager.rs` 复合 key、`types.rs` session_id 序列化（沿用现有 `#[cfg(test)]`）。
- 手动冒烟：A.7 / B.5 清单；D1 同 cwd 双会话并发跑 + 文件无串扰。
- 命令：前端 `cd tauri-agent && npx vitest run <file>` / `npx tsc --noEmit`；Rust `cargo test`（在 `src-tauri`）。

---

## 10. 推荐与里程碑

1. **M1（阶段 A）**：前端多 store 常驻 + 后台 flush fallback + Sidebar 运行角标。解锁"多对话后台并行、切回不丢流式"。后端 0 改动。
2. **M2（阶段 B）**：dock per-workspace 化 + 会话 tab 同屏。解锁"同屏多会话"。
3. **M3（阶段 D1）**：manager/registry key 升级为 `workspace::sessionId` + 同 cwd 并发 spike。解锁"同项目多会话并发"。
4. **M4（阶段 D2，可选）**：单进程多 runtime 省内存；优先走 pi 上游。

> 落地时每个阶段单独成一份 executing-plan（逐任务 + 末尾 commit），与本仓库 `docs/superpowers/plans/` 既有风格一致。本仓库**禁止子代理**，全程内联执行。

---

## 11. 参考实现与借鉴（GitHub 调研）

### 11.1 OpenClaw（pi 官方 README 点名的嵌入式集成）— D2 蓝图

- 用 `createAgentSession()` **直接嵌入,不走 RPC/subprocess**;`src/agents/pi-embedded-runner/` 即"单进程多 session"的现成参考实现。
- 可对照模块：`lanes.ts`（会话/全局队列）、`runs.ts`（活跃 run 跟踪/abort/队列）、`session-manager-cache.ts`、`session-manager-init.ts`、`pi-embedded-subscribe.ts`（事件桥接成回调）。
- **两级 Lane**：session lane（同会话串行 `maxConcurrent=1`）+ global lane（全局并发上限，分 Main/Cron/Subagent/Nested）。不同会话并行、同会话串行。
- **进程感知文件锁**：transcript 写受 session file 上 *process-aware + file-based* 锁保护（默认 `session.writeLock.acquireTimeoutMs=60000ms`），可拦截绕过内存队列的写者及**来自另一个进程的写者** → 兜底「一 path 一写者」。
- **身份三元组** `{ sessionId, sessionKey(=lane key), sessionFile(=jsonl path) }`，印证 §7「path 作主键」。
- 包差异：OpenClaw 用 `@mariozechner/pi-*` 0.61，本仓库 `@earendil-works/pi-coding-agent` 0.78，同源（`badlogic/pi-mono`）不同 scope/版本，API 基本通用。

### 11.2 OpenCode（单进程 server + SSE）— 方案 C / D2 的 server 范本

- Hono + Bun 单进程 server，REST + SSE，多 client 多 session 并发；session 存 SQLite。
- session REST 语义可映射成 sidecar 自建 RPC 命令集：`POST /session`、`GET /session/status`（一次拿所有会话状态）、`/session/:id/abort`、`/session/:id/fork`、parent/child（subagent）。
- **警示**：即便单进程，per-session 独立 LSP/MCP 实例 → 内存翻倍。**D2 的省内存有限**：pi `services` 里 skills/extensions/modelRegistry 可共享，但 MCP 连接、工具子进程仍 per-session。

### 11.3 借鉴决策（并入本方案）

1. **队列层（A 阶段即引入）**：两级 Lane = 同会话串行 + 全局并发上限（= 方案 E），防同开 N 会话打爆机器/LLM 配额。
2. **文件锁（D1）**：~~确认/启用 pi 文件锁~~ → **spike 已证 pi 无锁**（§7 D1）。D1 靠"一 sessionFile 一进程"规避 session 文件冲突，无需自加锁；真正需协调的是 cwd 级 `.pi/` 共享资源（checkpoint/kb/memory），让单一 cwd 主进程负责。OpenClaw 的进程级锁是其自加，可作为多 app 实例兜底的参考。
3. **D2 照 OpenClaw `pi-embedded-runner/` + `pi-embedded-subscribe.ts` 实现**（`Map<sessionFile, session>` + 事件桥接注入 sessionId），不从零设计。
4. **身份用三元组**，`sessionFile` 作主键/锁 key。
5. **内存预期修正**：D2 省内存有限，内存非瓶颈时 D1 性价比可能更高。
