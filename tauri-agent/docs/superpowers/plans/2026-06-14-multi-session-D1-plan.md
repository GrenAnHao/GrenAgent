# 阶段 D1 实现计划 — 同一项目目录多会话并发（每会话独立进程）

> **面向 AI 代理的工作者：** 用 `superpowers:executing-plans` 逐任务**内联**实现（本仓库**禁止子代理**）。步骤用 `- [ ]` 跟踪，每任务末尾 commit。
>
> **目标：** 把 PiManager / 前端 registry 的 key 从 `workspace`(cwd) 升级为 `clientId`（每会话一个 pi 进程），让**同一真实项目目录**也能并发多个会话。建立在阶段 A（多 store 常驻）之上——A 的核心（常驻/flush/角标/lanes）全部保留，仅 key 维度从 cwd 泛化为 clientId（即设计文档 §3 的「key 单点抽象」兑现）。
>
> 依据：`2026-06-14-multi-session-concurrency-design.md` §7 D1 + D1 spike 结论。

**命令约定：**
- 前端单测：`cd tauri-agent && npx vitest run <file>`；类型：`npx tsc --noEmit`
- Rust 测试：`cd tauri-agent/src-tauri && cargo test`

---

## 0. 前置事实（spike + 影响面调研，均已核查）

- **pi `SessionManager` 无文件锁**，延迟落盘（首个 assistant 才建文件，`openSync(...,"wx")` 排他创建）→ D1 守住「一 sessionFile 一进程」即无 session 冲突，且起进程→`switchSession` 不留空 jsonl。
- **后端仅 3 个文件依赖 `PiManager`**：`agent.rs`、`sessions.rs`、`workspaces.rs`。`kb/mem/cp/rv/files/git/create/terminal/shell` 全部按 cwd 独立操作文件系统，**D1 不改**。
- **cwd 级 `.pi/` 共享资源**（checkpoint=git、kb/memory=sqlite）各自有锁（git `index.lock` / sqlite busy）→ 同 cwd 多进程并发表现为**偶发 busy/失败而非数据损坏**，可接受或加重试，无需「单一主进程」重设计。

### 命令分类（决定改 key 还是保持 cwd）

| 类别 | 命令 | D1 处理 |
|---|---|---|
| **会话级**（依赖具体 pi 进程） | `agent_*`（prompt/steer/follow_up/abort/set_model/.../get_state/get_messages/new_session/switch_session/fork/clone/...）、`open_workspace`、`close_workspace`、`delete_pi_session`、`extension_ui_respond`、`auto_title_session` | 参数 `workspace` → `clientId` |
| **cwd 级**（不依赖进程） | `list_pi_sessions`、`list_all_sessions`、`create_conversation`、`get_works_dir`、`kb_*`、`mem_*`、`cp_*`、`rv_*`、`files`、`git`、`create_*`、`terminal`、`shell` | **不变**（仍按 cwd） |
| **cwd 级批量关进程** | `delete_conversation`、`remove_project` | `mgr.close(workspace)` → `mgr.close_by_cwd(cwd)` |

---

## 1. key 模型

- **`clientId`**：前端为每个「会话视图」生成的稳定 uuid（一个会话 = 一个 pi 进程实例）。
- **`PiManager`**：`HashMap<clientId, Arc<PiClient>>`；`PiClient` 记 `cwd`（用于 `close_by_cwd`）。
- **事件 envelope**：`{ clientId, event }`（取代 `{ workspace, event }`）；前端按 clientId 订阅。
- **命令**：会话级传 `clientId`；cwd 级传 `cwd`；`open_workspace(cwd, clientId)` 起进程。
- **前端**：`clientId` 为会话视图主键；`cwd`/`sessionPath` 经 sessionStore 映射（`clientId → { cwd, sessionPath }`）。
- **兼容**：「多对话/多项目」（不同 cwd）天然成立——每会话 1 个 clientId，进程 cwd 互不同；「同 cwd 多会话」= 多个 clientId 共享同一进程 cwd。

---

## 后端任务

### 任务 DB1：`PiManager` key → clientId + cwd 字段 + `close_by_cwd`

**文件：** `src-tauri/src/pi/manager.rs`（含 `#[cfg(test)]`）、`src-tauri/src/pi/client.rs`（PiClient 加 `cwd`）

- [ ] **步骤 1：`PiClient` 增加 `cwd` 字段**（client.rs）

`PiClient` 现有 `workspace` 字段用于事件路由——D1 改名为 `client_id`（语义：事件路由 key），并新增 `cwd`：

```rust
pub struct PiClient {
    client_id: String,   // 事件路由 key（原 workspace 字段改名）
    cwd: String,         // 进程工作目录（用于 close_by_cwd / cwd 级查询）
    transport: Arc<dyn PiTransport>,
    sink: Arc<dyn EventSink>,
    pending: Mutex<HashMap<String, oneshot::Sender<RpcResponse>>>,
}

impl PiClient {
    pub fn new(client_id: String, cwd: String, transport: Arc<dyn PiTransport>, sink: Arc<dyn EventSink>) -> Self { ... }
    pub fn cwd(&self) -> &str { &self.cwd }
    // handle_line / handle_exit 内 emit 改用 self.client_id（见 DB2）
}
```

> 全文件把 `self.workspace` → `self.client_id`；`PiClient::new` 签名加 `cwd`。更新 client.rs 内 `#[cfg(test)]` 的 `PiClient::new(...)` 调用。

- [ ] **步骤 2：manager 失败测试**（manager.rs `#[cfg(test)]`）

改 `fake_client` 签名带 cwd；新增用例：

```rust
#[tokio::test]
async fn reuses_client_per_clientid_and_closes_by_cwd() {
    let mgr = PiManager::new();
    mgr.get_or_open("c1", "/ws/a", || Ok(fake_client("c1", "/ws/a"))).await.unwrap();
    mgr.get_or_open("c2", "/ws/a", || Ok(fake_client("c2", "/ws/a"))).await.unwrap();
    mgr.get_or_open("c3", "/ws/b", || Ok(fake_client("c3", "/ws/b"))).await.unwrap();
    // 同 cwd 两个 client 并存
    assert!(mgr.get("c1").await.is_some());
    assert!(mgr.get("c2").await.is_some());
    // close_by_cwd 只关 /ws/a 的
    mgr.close_by_cwd("/ws/a").await;
    assert!(mgr.get("c1").await.is_none());
    assert!(mgr.get("c2").await.is_none());
    assert!(mgr.get("c3").await.is_some());
}
```

- [ ] **步骤 3：实现 manager.rs**

```rust
#[derive(Default)]
pub struct PiManager {
    clients: Mutex<HashMap<String, Arc<PiClient>>>, // key = clientId
}

impl PiManager {
    pub async fn get_or_open<F>(&self, client_id: &str, _cwd: &str, factory: F) -> Result<Arc<PiClient>>
    where F: FnOnce() -> Result<Arc<PiClient>> {
        let mut guard = self.clients.lock().await;
        if let Some(c) = guard.get(client_id) { return Ok(c.clone()); }
        let client = factory()?;
        guard.insert(client_id.to_string(), client.clone());
        Ok(client)
    }
    pub async fn get(&self, client_id: &str) -> Option<Arc<PiClient>> {
        self.clients.lock().await.get(client_id).cloned()
    }
    pub async fn close(&self, client_id: &str) {
        if let Some(c) = self.clients.lock().await.remove(client_id) {
            let _ = c.kill().await;
        }
    }
    /// 关闭某 cwd 下所有 client（delete_conversation / remove_project 用）。
    pub async fn close_by_cwd(&self, cwd: &str) {
        let mut guard = self.clients.lock().await;
        let victims: Vec<String> = guard.iter()
            .filter(|(_, c)| c.cwd() == cwd)
            .map(|(k, _)| k.clone())
            .collect();
        for k in victims {
            if let Some(c) = guard.remove(&k) { let _ = c.kill().await; }
        }
    }
    pub async fn close_all(&self) { /* 不变 */ }
}
```

- [ ] **步骤 4：`cargo test`（pi 模块）** → PASS。
- [ ] **步骤 5：Commit** `git commit -m "feat(pi): key PiManager by clientId, add cwd + close_by_cwd"`

### 任务 DB2：sink/client envelope 携带 clientId

**文件：** `src-tauri/src/pi/sink.rs`、`src-tauri/src/pi/client.rs`

- [ ] **步骤 1：`EventSink` 与 `TauriSink` 改 envelope key**

`sink.rs` 把 `emit_event(workspace, ...)` 形参语义改为 `client_id`，envelope 字段 `clientId`：

```rust
fn emit_event(&self, client_id: &str, event: &Value);
fn emit_ui_request(&self, client_id: &str, request: &Value);
fn emit_exit(&self, client_id: &str, code: Option<i32>);
// TauriSink: json!({ "clientId": client_id, "event": event }) 等
```

- [ ] **步骤 2：client.rs emit 调用改 `self.client_id`**（DB1 已改字段，确认 handle_line/handle_exit 三处 emit 传 `&self.client_id`）。
- [ ] **步骤 3：`cargo test`** → PASS（更新受影响断言）。
- [ ] **步骤 4：Commit** `git commit -m "feat(pi): event envelope carries clientId"`

### 任务 DB3：sidecar spawn + agent.rs 会话级命令改 clientId

**文件：** `src-tauri/src/pi/sidecar.rs`、`src-tauri/src/commands/agent.rs`

- [ ] **步骤 1：`spawn_pi_client` 签名**（sidecar.rs）

```rust
pub fn spawn_pi_client(app, client_id: String, cwd: &str, sink, env) -> Result<Arc<PiClient>> {
    // ...spawn 用 cwd...
    let client = Arc::new(PiClient::new(client_id, cwd.to_string(), transport, sink));
    // ...read loop 不变...
}
```

- [ ] **步骤 2：`open_workspace` 改为 `open_session`（cwd + clientId）**（agent.rs）

```rust
#[tauri::command]
pub async fn open_workspace(workspace: String, client_id: String, app, mgr, store) -> Result<OpenWorkspaceResult, String> {
    let cwd = resolve_workspace_dir(&workspace)?;
    let cwd_s = cwd.to_string_lossy().to_string();
    mgr.get_or_open(&client_id, &cwd_s, move || {
        let sink = Arc::new(TauriSink { app: app2.clone() });
        spawn_pi_client(&app2, client_id_for_spawn.clone(), &cwd_s2, sink, env.clone())
    }).await.map_err(|e| e.to_string())?;
    // restored_session / switch 逻辑：client_for 改用 client_id
    ...
}
```

- [ ] **步骤 3：会话级命令统一 `client_id`**

`agent.rs` 内 `client_for(mgr, &client_id)`；所有 `agent_*` 与 `agent_get_*` 的形参 `workspace: String` → `client_id: String`，`send(&mgr, &client_id, cmd)`。`close_workspace(client_id)` → `mgr.close(&client_id)`。

> `agent_switch_session` 仍带 `session_path`（切换该进程内会话文件）+ `store.set_last_session`——注意 last_session 现按 cwd 存，需 client→cwd 映射（从 `mgr.get(client_id).cwd()` 取 cwd）。

- [ ] **步骤 4：`cargo test` + Commit** `git commit -m "feat(pi): session commands keyed by clientId; spawn per session"`

### 任务 DB4：sessions.rs / workspaces.rs 适配

**文件：** `src-tauri/src/commands/sessions.rs`、`workspaces.rs`

- [ ] **步骤 1：会话级命令改 clientId**
  - `delete_pi_session(client_id, session_path, mgr)`：`pi_get_session_file`/`new_session` 用 `client_id`。
  - `extension_ui_respond(client_id, response, mgr)`：`mgr.get(&client_id)`。
  - `auto_title_session(client_id, app, mgr, store)`：`mgr.get(&client_id)`；其内部 `run_pi_print_title` 的 cwd 从 `client.cwd()` 取。
- [ ] **步骤 2：cwd 级 close 改 close_by_cwd**
  - `delete_conversation(workspace, mgr, store)`：`mgr.close(&workspace)` → `mgr.close_by_cwd(&workspace)`。
  - `remove_project(workspace, mgr, store)`：同上。
- [ ] **步骤 3：cwd 级查询不变**：`list_pi_sessions`、`list_all_sessions`、`create_conversation`、`get_works_dir` 保持 cwd 参数。
- [ ] **步骤 4：`cargo test` + Commit** `git commit -m "feat(pi): adapt sessions/workspaces to clientId + close_by_cwd"`

### 任务 DB5：lib.rs 校验 + 整体编译

- [ ] **步骤 1：`invoke_handler` 命令名不变**（仅签名变，注册无需改）；确认无遗漏命令。
- [ ] **步骤 2：`cd tauri-agent/src-tauri && cargo build`** → 无错误。
- [ ] **步骤 3：Commit**（若有 lib.rs 改动）`git commit -m "chore(pi): wire clientId commands"`

---

## 前端任务

### 任务 DF1：`lib/pi.ts` 命令 + 事件 envelope 改 clientId

**文件：** `src/lib/pi.ts`

- [ ] **步骤 1：envelope 类型**

```ts
export interface PiEventEnvelope { clientId: string; event: AgentEvent; }
export interface PiUiRequestEnvelope { clientId: string; request: ExtensionUiRequest; }
export interface PiExitEnvelope { clientId: string; code: number | null; }
```

- [ ] **步骤 2：会话级 API 加 clientId**

```ts
openWorkspace: (workspace: string, clientId: string) =>
  invoke<OpenWorkspaceResult>('open_workspace', { workspace, clientId }),
closeWorkspace: (clientId: string) => invoke<void>('close_workspace', { clientId }),
prompt: (clientId, message, streamingBehavior?, images?) =>
  invoke('agent_prompt', { clientId, message, images: ..., streamingBehavior }),
abort: (clientId) => invoke('agent_abort', { clientId }),
// ...其余 agent_* / get_* / newSession / switchSession / setSessionName / respondUi / autoTitleSession / deleteSession 同改第一参为 clientId
```

> cwd 级 API（`listSessions`/`listAllSessions`/`createConversation`/`getWorksDir`/`kb*`/`mem*`/`cp*`/`rv*`/`createList`/`getGitDiff` 等）**保持 workspace 参数不变**。

- [ ] **步骤 3：Commit** `git commit -m "feat(pi-client): clientId for session commands + event envelope"`

### 任务 DF2：`agent.ts` 按 clientId 订阅

**文件：** `src/stores/agent.ts`、`src/stores/agent.test.ts`

- [ ] **步骤 1：`createAgentStore(clientId)`**：`onPiEvent`/`onPiExit` 过滤 `env.clientId !== clientId`（原 `env.workspace !== workspace`）。
- [ ] **步骤 2：测试**：`agent.test.ts` 的 `emit` 改发 `{ clientId: 'c', event }`，`createAgentStore('c')`。
- [ ] **步骤 3：`vitest run src/stores/agent.test.ts` + Commit** `git commit -m "feat(agent): subscribe events by clientId"`

### 任务 DF3：registry / context key → clientId

**文件：** `src/stores/agentStoreRegistry.ts`（+test）、`src/stores/AgentStoreContext.tsx`

- [ ] **步骤 1：registry**：`getOrCreate(clientId)`、`runningWorkspaces` → `runningClients`（语义为 clientId 集合）。其余逻辑不变（key 现是 clientId）。
- [ ] **步骤 2：context**：`AgentStoreProvider` 的 prop `workspace` → `clientId`；`getOrCreate(clientId)` + `setActive(clientId)`。`AgentStoreContextValue` 暴露 `clientId`（+ 可选 `cwd`，从 sessionStore 映射读）。
- [ ] **步骤 3：测试更新 + Commit** `git commit -m "feat(agent): registry/context keyed by clientId"`

### 任务 DF4：`App.tsx` + `store/session.ts` 分配 clientId

**文件：** `src/App.tsx`、`src/store/session.ts`

- [ ] **步骤 1：sessionStore 映射**

```ts
// clientId → { cwd, sessionPath }；activeClientId 取代 activeWorkspace 作为“当前视图”主键
clients: Record<string, { cwd: string; sessionPath: string | null }>;
activeClientId: string | null;
setActiveClient: (clientId: string) => void;
upsertClient: (clientId: string, cwd: string, sessionPath: string | null) => void;
```
> `activeWorkspace` 可保留为派生（`clients[activeClientId]?.cwd`）以减少调用方改动。

- [ ] **步骤 2：打开/新建会话分配 clientId**
  - `handleOpenSession(cwd, path)`：若该 (cwd, path) 已有 clientId 复用，否则 `crypto.randomUUID()` 新建；`upsertClient(clientId, cwd, path)`；`openWorkspace(cwd, clientId)`；`setActiveClient(clientId)`。
  - `handleNewSession(cwd)` / `handleNewConversation()`：生成新 clientId，`openWorkspace(cwd, clientId)` + `newSession(clientId)`。
  - **同 cwd 多会话**：同一项目目录"新建会话"= 新 clientId（新进程），不再 `switch_session` 顶掉旧的。
- [ ] **步骤 3：Provider 用 activeClientId**：`<AgentStoreProvider clientId={activeClientId}>`。
- [ ] **步骤 4：运行角标**：T4 的 `runningSessionPaths` 改由 `runningClients`（registry）→ 经 `clients[clientId].sessionPath` 映射（逻辑同 A1-T4，维度换 clientId）。
- [ ] **步骤 5：`tsc` + 受限 vitest + Commit** `git commit -m "feat(app): allocate clientId per session view"`

### 任务 DF5：UI 支持同 cwd 多会话 + 收尾

**文件：** `src/features/sessions/*`（按需）、手动冒烟

- [ ] **步骤 1**：Sidebar 项目组「新建会话」语义 = 新 clientId 进程（可同 cwd 并存多个活跃会话）；会话项点击 = 切到对应 clientId（已有则复用，未开则起进程）。
- [ ] **步骤 2：手动冒烟（dev）**：同一项目目录开 2 个会话 → 各自发 prompt → **同时流式、互不干扰**；切换不丢流式；删除项目关闭其全部进程；`.pi/` checkpoint/kb 偶发 busy 时不崩（如需可加重试）。
- [ ] **步骤 3：Commit**（如有）。

---

## 风险与对策

| 风险 | 对策 |
|---|---|
| 同 sessionFile 被两进程写 | manager key=clientId + 前端「(cwd,path) 复用同 clientId」；不重复为同一 path 起第二进程 |
| 多 app 实例对同一 file 无跨进程锁 | 边缘场景；可加 app 级 lockfile（参考 OpenClaw），或接受（现状亦然） |
| `.pi/` git/sqlite 并发 busy | git/sqlite 自带锁，表现为偶发失败非损坏；按需加重试/提示 |
| 同 cwd N 进程内存 | registry LRU（A1 已有）+ 全局并发 lane（A2 已有）；可设每 cwd 进程上限 |
| key 重构波及 A1 代码 | 改动集中在 registry/context/App/pi.ts/agent.ts；A1 核心逻辑保留，仅 key 维度泛化 |

## 测试策略

- Rust：`manager.rs`（close_by_cwd/复合并存）、`types/client/sink`（envelope clientId）单测；`cargo test`。
- 前端：`agent.test.ts`（clientId 过滤）、`agentStoreRegistry.test.ts`（key=clientId）；受限 `vitest run src/stores src/lib`。
- 手动：同 cwd 双会话并发冒烟（DF5 步骤 2）。

## 执行顺序与交接

后端 DB1→DB5 先行（可独立编译/测试），再前端 DF1→DF5；每任务末尾 commit。DB1/DB2 是地基（key + envelope），务必先稳。**禁止子代理，内联执行。**
