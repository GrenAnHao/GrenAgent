# 「对话 / 项目」双模式 设计规格（定稿 v2）

> **面向 AI 代理：** 这是设计规格（spec）。下一步用 `superpowers:writing-plans` 产出实现计划，再用 `superpowers:executing-plans` 内联执行（本仓库**禁止子代理**）。

**目标：** 在 `tauri-agent` GUI 中引入两类入口——「对话」（无需选目录，自动在 `~/.pi/agent/works/<uuid>` 建临时工作目录）与「项目」（用户自选真实目录）——并支持「删除对话」「移除项目」，以及参考 MiMo-Code 的**对话标题自动生成**。

**架构：** 复用现有 pi 的 `(cwd, session)` 机制，**不引入额外数据库/元数据**。区分两种模式的唯一判据是 *cwd 是否位于 `~/.pi/agent/works/` 之下*。

**技术栈：** Tauri（Rust）+ React/TypeScript（zustand + @lobehub/ui + antd-style）。

---

## 1. 背景与现状（要点）

- **workspace = cwd = key。** `PiManager` 用 `HashMap<workspace, PiClient>` 为每个 cwd 复用一个 pi sidecar（`pi/manager.rs`）。
- **会话由 pi 管理**，存 `~/.pi/agent/sessions/<cwd-hash>/*.jsonl`，首行 header 含 `id / cwd / timestamp / name`（`commands/sessions.rs`）。
- **sidecar 用 `.current_dir(cwd)` 绑定工作目录**，不覆盖 `PI_CODING_AGENT_DIR`，故 pi 用默认 `~/.pi/agent`（`pi/sidecar.rs`）。
- **AppState**（`app-state.json`）：`recent_workspaces`、`last_sessions`、`approved_workspaces`、`settings`（env map）。
- **前端**：`store/session.ts`（`activeWorkspace` 默认 `'.'`、`allSessions`）；`useProjectGroups` 按 cwd 分组；`Sidebar` 渲染「置顶/项目」；`App.tsx` 的 `Workspace` 在 `activeWorkspace` 变化时 `openWorkspace`，持有 `handleNewSession/OpenSession/DeleteSession/SubmitRename`。
- **pi 命名能力**：仅手动 `set_session_name`（RPC），**无自动标题生成**。
- **pi 模型信息**：`get_available_models` 返回模型，字段 `provider / id / contextWindow / reasoning`，**无大小/价格/lite 标记**。

---

## 2. 核心概念模型

| | 对话 Conversation | 项目 Project |
|---|---|---|
| cwd 来源 | App 自动建 `~/.pi/agent/works/<uuid>` | 用户自选真实目录 |
| 判据 | `cwd` 在 `~/.pi/agent/works/` 之下 | 其它所有 `cwd` |
| 粒度 | **1 对话 = 1 个 works/<uuid> = 1 条会话线** | 1 项目 = 1 cwd，其下可多会话 |
| 删除语义 | 删整个 `works/<uuid>` 目录（含会话文件） | 清空该 cwd 在 `sessions/` 下全部会话文件，**不动真实目录** |
| UI 位置 | 侧栏「对话」平铺区 | 侧栏「项目」分组区 |

---

## 3. 功能需求（FR）

- **FR-1 新建对话**：「对话」区右上「新建对话」图标（快捷键 `Ctrl+Alt+N`）→ 后端建 `works/<uuid>` → 前端以该路径为 workspace 打开并开新会话。
- **FR-2 新建项目**：「项目」区右上「新建项目」菜单，两项：
  - **新建空白项目**：系统目录选择器（用户可在其中新建文件夹）→ 选中目录作为项目打开。
  - **使用现有文件夹**：系统目录选择器选已有目录 → 作为项目打开。
- **FR-3 对话列表**：「对话」区平铺展示所有对话，标题取 `session.name`，为空回退到本地化时间串；可点击进入、重命名、删除。
- **FR-4 删除对话**：删除该对话的 `works/<uuid>` 整个目录及其会话文件；若为当前活跃则先切走。
- **FR-5 移除项目**：删除该项目 cwd 在 `sessions/` 下**全部**会话文件，并从 `recent_workspaces / last_sessions` 移除；**绝不删除用户真实目录**；若为当前活跃则先切走。
- **FR-6 模式隔离**：「项目」区**不得**出现 works 目录；「对话」区**只**出现 works 目录。
- **FR-7 对话标题自动生成**：对话首轮结束后，若标题仍为默认（空/时间占位），用小模型按首条用户消息生成标题（≤100 字符），写回 `set_session_name`。仅对「对话」生效（项目沿用 pi 现状，手动命名）。
- **FR-8 启动默认**：启动时取 `list_all_sessions` 中最新一条会话的 `cwd`（若目录仍存在）作为恢复目标；若无任何会话则自动新建一个对话。取代现有写死的 `'.'`。（复用既有命令，无需暴露 `recent_workspaces`。）

---

## 4. 非目标（YAGNI）

- 不引入数据库/新持久化元数据（判据靠目录前缀）。
- 不修改 `pi` 本体（标题生成用临时 print-mode sidecar，不加 pi RPC）。
- 不为「对话」提供多会话/分支 UI（对话即单会话线；底层若产生分支折叠为一条）。
- 不替换现有 `hideProject`（前端软隐藏）——与 FR-5 真正清空并存。
- 项目不做自动标题生成（仅对话做）。

---

## 5. 架构设计

### 5.1 目录与判据

- works 根：`~/.pi/agent/works`（与 `sessions.rs::sessions_dir` 同源）。
- 单对话目录：`~/.pi/agent/works/<uuid-v4>`。
- 判据（前端）：`isUnder(cwd, worksDir)`；后端 `get_works_dir` 暴露规范化根，前端启动取一次缓存。

### 5.2 后端命令（Rust，`src-tauri`）

新增 `src-tauri/src/commands/workspaces.rs`，并在 `commands/mod.rs`、`lib.rs` 注册。

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationInfo { pub cwd: String }

/// FR-1：在 ~/.pi/agent/works/<uuid> 建目录，返回 canonical 路径。
#[tauri::command]
pub async fn create_conversation() -> Result<ConversationInfo, String>;

/// 供前端前缀判断：~/.pi/agent/works 的 canonical 路径（不存在则先建）。
#[tauri::command]
pub async fn get_works_dir() -> Result<String, String>;

/// FR-4：校验在 works 根下 → 若进程在跑先 close → 删该 cwd 会话文件
///        → 删整个 works/<uuid> 目录 → AppState 移除。
#[tauri::command]
pub async fn delete_conversation(
    workspace: String,
    mgr: State<'_, Arc<PiManager>>,
    store: State<'_, AppStateStore>,
) -> Result<(), String>;

/// FR-5：若进程在跑先 close → 删该 cwd 在 sessions/ 下全部会话文件
///        → AppState 移除。不动真实目录。
#[tauri::command]
pub async fn remove_project(
    workspace: String,
    mgr: State<'_, Arc<PiManager>>,
    store: State<'_, AppStateStore>,
) -> Result<(), String>;

/// FR-7：为某对话生成并写回标题。返回生成的标题（失败返回 None）。
/// 内部：取首条 user 消息 → 选小模型（§5.7 三级 fallback）
///       → 临时 print-mode sidecar 生成 → 常驻 client set_session_name。
#[tauri::command]
pub async fn auto_title_session(
    workspace: String,
    app: tauri::AppHandle,
    mgr: State<'_, Arc<PiManager>>,
    store: State<'_, AppStateStore>,
) -> Result<Option<String>, String>;
```

> **新建项目无需后端命令**：「新建空白项目 / 使用现有文件夹」前端都走目录选择器 → 既有 `open_workspace` 流程，区别仅 dialog 文案。

**共享辅助**（`workspaces.rs`，复用 `sessions.rs` 既有 `sessions_dir / collect_session_files / read_first_line / parse_session_header / paths_equivalent`）：

```rust
fn works_dir() -> Option<std::path::PathBuf>;            // ~/.pi/agent/works
fn delete_sessions_for_cwd(cwd: &str) -> Result<usize, String>; // 仅删 sessions/ 内匹配 cwd 的 jsonl
```

**`AppState` 新增**（`state/app_state.rs`）：

```rust
pub fn forget_workspace(&mut self, ws: &str) {
    self.recent_workspaces.retain(|w| w != ws);
    self.last_sessions.remove(ws);
}
```

### 5.3 前端：状态与派生

- **`store/session.ts`**：新增 `worksDir: string`（默认 `''`）+ `setWorksDir`；启动调 `pi.getWorksDir()` 写入。
- **`lib/pi.ts`**：新增 `createConversation / getWorksDir / deleteConversation / removeProject / autoTitleSession` 封装。
- **`lib/pathUtils.ts`**：新增 `isUnder(cwd, root)`（分隔符无关，Windows 大小写不敏感）。
- **`lib/dialog.ts`（新）**：`pickDirectory(): Promise<string | null>`（封装 `@tauri-apps/plugin-dialog` 的 `open({ directory: true })`）。
- **`features/sessions/useConversations.ts`（新）**：从 `allSessions` 派生对话列表，每个 works cwd 折叠为一条（取最新）。
- **`features/sessions/useProjectGroups.ts`（改）**：`buildProjectGroups` 增 `worksDir` 参数，`if (worksDir && isUnder(s.cwd, worksDir)) continue;`（满足 FR-6）。

### 5.4 前端：侧栏 UI（codex 风格分区，`features/sessions`）

参照 codex：**每个分区有自己的 section header + 区级操作**。

- **「对话」区**：section header「对话」+ 右上「新建对话」图标（`MessageSquarePlus`，title 提示 `Ctrl+Alt+N`）；下方平铺 `useConversations()`，复用 `SessionItem`（标题/激活/运行/重命名/删除）。对话项 `onDelete` → `onDeleteConversation(cwd)`；`onClick` → `onOpenSession(cwd, sessionPath)`。
- **「项目」区**：section header「项目」+ 右上「新建项目」下拉（`@lobehub/ui` Dropdown 或 base-ui DropdownMenu）：「新建空白项目」「使用现有文件夹」→ 均 `onOpenProject()`。下方现状 `ProjectGroup`（已排除 works）。
- **`ProjectItem.tsx`（改）**：项目菜单新增「移除项目」（破坏性，红色）→ `onRemoveProject(cwd)`。
- **`SidebarActions.tsx`**：原全局「新建会话」由上述两个区级入口取代；保留「搜索会话」。项目组内「在此项目新建会话」(`onNewInProject`) 保留。
- **快捷键**：`Ctrl+Alt+N` 触发「新建对话」（全局键监听，见接线）。

### 5.5 前端：接线（`App.tsx` 的 `Workspace`）

```typescript
// FR-1 + 快捷键 Ctrl+Alt+N
const handleNewConversation = useCallback(async () => {
  const { cwd } = await pi.createConversation();
  invalidateAllSessionsCache();
  const st = useSessionStore.getState();
  st.setActiveSession('');
  st.setActiveWorkspace(cwd); // 触发 openWorkspace
  void refreshAllSessions(true);
}, []);

// FR-2（新建空白项目 / 使用现有文件夹 共用）
const handleOpenProject = useCallback(async () => {
  const dir = await pickDirectory();
  if (!dir) return;
  const st = useSessionStore.getState();
  st.setActiveSession('');
  st.setActiveWorkspace(dir);
  void refreshAllSessions(true);
}, []);

// FR-4
const handleDeleteConversation = useCallback(async (cwd: string) => {
  await pi.deleteConversation(cwd);
  invalidateAllSessionsCache();
  if (useSessionStore.getState().activeWorkspace === cwd) await goToSafeWorkspace();
  void refreshAllSessions(true);
}, []);

// FR-5
const handleRemoveProject = useCallback(async (cwd: string) => {
  await pi.removeProject(cwd);
  invalidateAllSessionsCache();
  if (useSessionStore.getState().activeWorkspace === cwd) await goToSafeWorkspace();
  void refreshAllSessions(true);
}, []);

// FR-7：对话首轮 agent_end 后触发（仅 works 下、且标题仍默认）
async function maybeAutoTitle(workspace: string) {
  if (!isUnder(workspace, useSessionStore.getState().worksDir)) return;
  const title = await pi.autoTitleSession(workspace);
  if (title) { invalidateAllSessionsCache(); void refreshAllSessions(true); }
}

// FR-8：启动默认（复用 list_all_sessions，取最新会话的 cwd）
async function pickStartupWorkspace(): Promise<string> {
  const all = await pi.listAllSessions(); // 已按 timestamp 倒序
  const latest = all[0]?.cwd;
  if (latest) return latest; // 目录不存在时 openWorkspace 会失败 → 由调用方回退新建对话
  const { cwd } = await pi.createConversation();
  return cwd;
}
```

`goToSafeWorkspace()`：`refreshAllSessions(true)` 后取剩余 `allSessions[0].cwd`（排除刚删除者）切入；若已无任何会话则 `handleNewConversation()` 兜底。

### 5.6 数据流（新建对话 + 自动标题）

```
点击「新建对话」/Ctrl+Alt+N
  → pi.createConversation()         [Rust] mkdir ~/.pi/agent/works/<uuid>
  → setActiveWorkspace(cwd)         [前端] AgentStoreProvider 重建
  → useEffect: pi.openWorkspace(cwd)[Rust] spawn pi(cwd=works/<uuid>)，新会话
  → 用户首条消息 → agent_end
  → maybeAutoTitle(cwd)
     → pi.autoTitleSession(cwd)     [Rust] 取首条消息 + 选小模型 + 临时 print sidecar 生成
                                          → 常驻 client set_session_name
  → refreshAllSessions → 「对话」区显示生成的标题
```

### 5.7 对话标题自动生成（参考 MiMo-Code，适配 pi）

**触发**（前端）：监听 `agent_end`，当 `isUnder(workspace, worksDir)` 且该会话标题仍为默认（`name` 为空）时，调 `pi.autoTitleSession(workspace)`。仅首次（生成后 `name` 非空即不再触发）。

**选模型（三级 fallback，Rust）**：
1. **设置项**：`AppState.settings["titleModel"]`（`provider/modelId`，前端设置面板新增一项）若有 → 用它。
2. **启发式**：`get_available_models` 中，**当前对话 provider** 下，按轻量关键词匹配挑一个：`haiku|mini|flash|lite|small|nano|air|8b|7b|4b|1b`（优先 `reasoning=false`，再按 `contextWindow` 较小者）。
3. **兜底**：当前对话主模型。

**生成（Rust，临时 print-mode sidecar）**：
- `pi -p --no-session --no-tools --provider <p> --model <m>`，stdin/arg 传 `"Generate a title for this conversation:\n" + 首条用户消息`。
- 取 stdout，按 MiMo-Code 清洗：去 `<think>...</think>`、取首个非空行、`>100 → substring(0,97)+"..."`。
- 经常驻 client 发 `set_session_name`。
- 通过 `app.shell().sidecar("pi").args([...]).output()` 一次性执行；异步，失败静默（容错）。

> 首条用户消息来源：经常驻 client `get_messages` 取第一条 role=user 的文本。

### 5.8 设置项

`AppState.settings` 新增 app 级键 `titleModel`（值 `provider/modelId`，可空）。前端设置面板加一项「对话标题模型（可选）」。该键不注入 sidecar env（`settings_env` 过滤掉 `titleModel`，或后端单独读取，避免干扰 pi）。

---

## 6. 新依赖

- `tauri-plugin-dialog`（目录选择器）：
  - Rust：`Cargo.toml` 加 `tauri-plugin-dialog`；`lib.rs` `.plugin(tauri_plugin_dialog::init())`。
  - 前端：`@tauri-apps/plugin-dialog`。
  - `src-tauri/capabilities/*.json` 放行 dialog 权限。

---

## 7. 错误处理与安全边界

- **`delete_conversation` 越界防护**：`canonicalize(workspace)` 必须 `starts_with(canonicalize(works_dir))`，否则拒绝；拒绝符号链接；`remove_dir_all` 前再确认在 works 根内。（同 `delete_pi_session` 思路）
- **`remove_project` 真实目录保护**：只遍历 `sessions_dir()` 删 `.jsonl`，不触碰 `workspace` 真实目录；`delete_sessions_for_cwd` 内每个待删文件校验 `starts_with(sessions_root)`、扩展名 `jsonl`、非符号链接。
- **进程清理**：删除前若 `mgr.get(workspace)` 命中先 `mgr.close(workspace)`（Windows 防占用）。
- **标题生成容错**：取不到首条消息/小模型/超时/sidecar 失败 → 返回 `None`，不影响对话。
- **二次确认**（前端）：「删除对话」「移除项目」弹确认；文案明确「移除项目不会删除你的代码目录，只清空其对话记录」。

---

## 8. 边界情况

- **删除/移除当前活跃**：`goToSafeWorkspace()` 切到 recent 下一个或新建对话兜底。
- **works cwd 下多会话**：对话列表每 cwd 折叠一条（最新）；删除删整个目录。
- **标题生成竞态**：同一对话仅当 `name` 为空时触发；写回后 `refreshAllSessions` 更新。
- **启动默认**：见 FR-8 / `pickStartupWorkspace`。

---

## 9. 测试策略

遵循现有风格（Rust `#[cfg(test)]`；前端 `*.test.ts(x)` + vitest）。

**Rust**
- `works_dir()` = `~/.pi/agent/works`。
- `delete_sessions_for_cwd`：仅删匹配 cwd，保留其它；返回条数。
- `delete_conversation` 越界/符号链接被拒。
- `remove_project`：构造临时真实目录 + 会话文件，断言真实目录仍在、会话被删。
- `AppState::forget_workspace`：同时移除 recent 与 last_sessions。
- 标题小模型启发式：给定模型列表，按 provider + 关键词挑中预期模型；无匹配回退当前模型。

**前端**
- `isUnder`：分隔符/大小写/前缀边界（`/a/b` 不在 `/a/bc` 下）。
- `buildProjectGroups`：传 worksDir 后 works cwd 不出现在项目分组。
- `useConversations`：每 works cwd 折叠一条、取最新、`isCurrent` 正确。
- 标题清洗：去 think、取首非空行、>100 截断。

---

## 10. 已决议（原开放问题）

1. 启动默认 → **纳入本次**：恢复 recent 首个存在者，否则新建对话（FR-8）。
2. 旧「新建会话」入口 → 顶部由「对话区新建对话 / 项目区新建项目菜单」取代；项目组内「在此新建会话」保留。
3. 对话默认名 → `session.name`，空则回退时间串；首轮后由小模型生成覆盖（FR-7）。
4. 新建空白项目 → 系统目录选择器自选/新建文件夹（FR-2）。
5. 标题小模型策略 → 三级 fallback：设置 `titleModel` → 启发式按 provider 挑轻量 → 兜底当前主模型（§5.7）。
6. 标题生成实现 → 临时 print-mode sidecar，不改 pi（§5.7）。

---

## 11. 变更文件清单（供 writing-plans 展开）

**Rust**
- 新增 `src-tauri/src/commands/workspaces.rs`（`create_conversation / get_works_dir / delete_conversation / remove_project / auto_title_session` + `works_dir / delete_sessions_for_cwd / 标题小模型启发式 / 标题清洗`）
- 改 `src-tauri/src/commands/mod.rs`（导出）
- 改 `src-tauri/src/commands/sessions.rs`（如需共享辅助则 `pub(crate)`）
- 改 `src-tauri/src/state/app_state.rs`（`forget_workspace`）
- 改 `src-tauri/src/lib.rs`（注册新命令 + dialog 插件）
- 改 `src-tauri/capabilities/*.json`（dialog 权限）
- 改 `src-tauri/Cargo.toml`（`tauri-plugin-dialog`）

**前端**
- 改 `src/lib/pi.ts`（5 个封装）
- 改 `src/lib/pathUtils.ts`（`isUnder`）
- 新增 `src/lib/dialog.ts`（`pickDirectory`）
- 改 `src/store/session.ts`（`worksDir`）
- 新增 `src/features/sessions/useConversations.ts`
- 改 `src/features/sessions/useProjectGroups.ts`（worksDir 过滤）
- 改 `src/features/sessions/Sidebar.tsx`（对话区 + 项目区 header/菜单）
- 改 `src/features/sessions/SidebarActions.tsx`（入口调整）
- 改 `src/features/sessions/ProjectItem.tsx`（移除项目）
- 改 `src/App.tsx`（接线 + 启动默认 + Ctrl+Alt+N + agent_end 自动标题）
- 改设置面板（`features/settings/*`，新增 `titleModel` 项）
- `package.json`（`@tauri-apps/plugin-dialog`）
- 对应 `*.test.ts(x)`
