# 工作区 + Git 功能栏 + 后台任务 设计方案

状态: 草案 (Draft)
日期: 2026-06-17
范围: `tauri-agent`（前端 React + 后端 Rust/Tauri）

## 1. 背景与目标

参考 ZCode / codex / lobehub 的输入区设计，在聊天输入框上方增加一条「工作区 / Git 功能栏」(WorkspaceBar)，把与当前仓库相关的高频操作集中到一处：

- Git 分支切换（含未提交改动数标记）
- Git diff 查看（agent 改了哪些文件 / 具体 diff）
- Git 图谱（提交历史 graph）
- 创建并检出新分支
- 后台任务列表 / 状态显示

工作区 / 目录选择本期不展开，但容器为其预留位置。

设计原则：最大化复用现有后端 (`git.rs` / `subagent`) 与前端约定 (`ActionBar` / `setStatus` / `MessageEditor` 接入层)，避免重复造轮子；不引入 emoji，图标统一用 `@lobehub/ui` 的 `Icon` + `lucide-react`。

## 2. 现状盘点（可复用基础）

后端 (`tauri-agent/src-tauri/src/commands/`)

- `git.rs`
  - `get_git_status(workspace_path) -> Vec<FileStatus{path, status}>`：未提交文件列表（modified/staged/untracked）。已有。
  - `get_git_diff(workspace_path, file_path) -> String`：单文件 diff。已有。
  - 内部已有 `run_git(cwd, args)`、`is_git_repo(cwd)`、`resolve_workspace_dir`、porcelain 解析等基础设施。
- `subagent.rs`：`subagent_list` / `subagent_cancel`，返回 `SubAgentItem{ id, task, status, model, profile, output, error, exitCode, createdAt, updatedAt }`。可直接作为「后台任务」的数据源。
- `checkpoint.rs`：`cp_list` / `cp_diff`，是另一种「改动快照 + diff」来源，可作为 diff 视图的备用数据源。

前端 (`tauri-agent/src/`)

- `lib/pi.ts`：所有后端 command 的 `invoke` 封装；已暴露 `getGitDiff`、`subagentList`、`subagentCancel`。
- `features/chat/input/`
  - `editor/MessageEditor.tsx`：输入区组装层。`zone` 内依次渲染 `SteerQueue` / `GoalPill` / `PromptRequestCard`，随后是 `surface`（编辑器 + `ActionBar` + `SendArea`）。**这就是功能栏的接入点。**
  - `ActionBar.tsx` + `config.tsx`：动作工具栏与注册表（key→组件 + overflow 折叠 + 宽度估算）。
  - `ChatInputContext.tsx`：输入区共享状态（含 `isStreaming`）。
- `stores/`：`goalStore` / `modeStore` / `mcpStatusStore` / `planModeStore`，均为 zustand，由 sidecar 经 `setStatus` 推送回读。
- `features/extensionUi/ExtensionUiHost.tsx`：`setStatus` 分发中心（`statusKey` → 对应 store）。
- `features/dock/SubAgentBody.tsx`：子代理（后台任务）现有展示，可参考其渲染与状态色。

约定

- UI：`@lobehub/ui`（`Popover` / `ActionIcon` / `Icon` / `Flexbox`）+ `lucide-react` 图标 + `antd-style` 的 `createStaticStyles` / `cssVar`。
- 无 emoji；文案中文。
- 新 Tauri command 需在 `lib.rs` 的 `generate_handler!` 注册。

## 3. 总体设计

在 `MessageEditor` 的 `zone` 内、`GoalPill` 同层加入 `WorkspaceBar`：

```
[ 工作区 v ]  [ 分支 v · 3 改动 ]  [ 图谱 ]  [ 后台任务 · 2 ]
```

- 工作区按钮：当前目录名（本期只读展示，下拉留扩展）。
- 分支按钮：当前分支名 + 未提交改动数徽标；点开 `BranchPicker`（搜索 + 分支列表 + 创建并检出 + 图谱入口）。
- 改动数徽标点击：直接打开 `DiffPanel`。
- 图谱按钮：打开 `GitGraphPanel`。
- 后台任务按钮：M 个运行中徽标；点开 `TaskTray`（复用 `subagent`）。

弹层统一用 `Popover`（轻量列表）或浮层面板（diff / 图谱这类大内容）。视觉与 `GoalPill` 一致：`colorBgElevated` + `colorBorderSecondary` + `borderRadiusLG`。

## 4. 后端设计（扩展 `git.rs` + 复用 `subagent`）

新增 command（沿用 `run_git` + `resolve_workspace_dir` + `is_git_repo` 守卫，非 git 仓库一律安全返回空/错误）：

| command | 入参 | 返回 | git 实现 |
| --- | --- | --- | --- |
| `get_git_branches` | `workspace_path` | `{ current: String, branches: Vec<BranchInfo> }` | `git branch --format=...` + `rev-parse --abbrev-ref HEAD` |
| `git_checkout` | `workspace_path, branch` | `()` | `git checkout <branch>` |
| `git_create_branch` | `workspace_path, name, checkout: bool` | `()` | `git checkout -b <name>` / `git branch <name>` |
| `get_git_log_graph` | `workspace_path, limit` | `Vec<GitLogEntry>` | `git log --graph --pretty=...`，或结构化 `git log --pretty=format:%H%x1f%P%x1f%an%x1f%s` 自行连边 |
| `get_git_status` | （已有） | `Vec<FileStatus>` | 未提交计数 = `len()` |
| `get_git_diff` | （已有） | `String` | 单文件 diff |

数据结构（与 `FileStatus` 同风格，`serde` 序列化）：

```rust
pub struct BranchInfo { pub name: String, pub is_current: bool, pub upstream: Option<String>, pub ahead: u32, pub behind: u32 }
pub struct GitLogEntry { pub hash: String, pub parents: Vec<String>, pub author: String, pub subject: String, pub timestamp: i64, pub refs: Vec<String> }
```

后台任务：本期不新增后端，直接用 `subagent_list`（运行中的子代理即「后台任务」）。后续若要纳入「异步会话任务」，可参考 lobehub 的 task 轮询模型再扩展。

注册：以上 command 加到 `lib.rs` 的 `tauri::generate_handler![]`。

## 5. 前端设计

### 5.1 数据流

- `pi.ts` 扩展：
  - `getGitBranches(workspace)`、`gitCheckout(workspace, branch)`、`gitCreateBranch(workspace, name, checkout)`、`getGitLogGraph(workspace, limit)`、`getGitStatus(workspace)`（status 已有 diff，补 status）。
- 新增 `stores/gitStore.ts`（zustand）缓存 `{ current, branches, changes, log }`，按 workspace 维度；或用一个 `useGitInfo(workspace)` hook 内部 `invoke` + 轮询。
- 刷新时机：
  - 打开对应 Popover 时拉取（懒加载）。
  - 监听 `pi://event` 的 `agent_end` / `tool_execution_end`（agent 可能改了文件）→ 刷新 status / branches。
  - 切换 workspace 时重置。
- 后台任务：复用 `pi.subagentList(workspace)` + 轮询（或现有 subagent 事件），与 dock `SubAgentBody` 共享数据来源。

### 5.2 组件结构（新增于 `features/chat/input/workspace/`）

```
WorkspaceBar.tsx            // 容器，渲染于 MessageEditor 的 zone（GoalPill 同层）
  WorkspacePill.tsx         // 当前工作区（本期只读，下拉留空壳）
  BranchPicker.tsx          // Popover：搜索框 + 分支列表 + 当前态 + 「创建并检出」+ 「Git 图谱」入口
    CreateBranchInline.tsx  // 输入新分支名 → git_create_branch
  ChangesButton.tsx         // 「N 改动」徽标 → 打开 DiffPanel
  GitGraphButton.tsx        // 「图谱」→ 打开 GitGraphPanel
  TaskTrayButton.tsx        // 「后台任务 · M」→ 打开 TaskTray
DiffPanel.tsx               // 文件列表（get_git_status）+ 选中看 get_git_diff，行级高亮
GitGraphPanel.tsx           // 渲染 get_git_log_graph（ref/分支标签 + 连线）
TaskTray.tsx                // 复用 subagentList，列出任务 + 状态 + 取消
```

DiffPanel 的 diff 高亮可优先复用现有展示（如 `checkpoint` 的 `cp_diff` 视图 / `code-review` 相关组件）；若无现成组件，按行 `+/-` 上色即可（`colorSuccess` / `colorError` 背景淡色）。

### 5.3 接入点

`MessageEditor.tsx` 的 `zone` 内插入一行：

```tsx
<SteerQueue />
<GoalPill />
<WorkspaceBar />   {/* 新增 */}
<PromptRequestCard />
<div ref={surfaceRef} className={styles.surface}> ... </div>
```

`WorkspaceBar` 内部用 `useAgentStoreContext()` 拿 `workspace`，与 `GoalPill` 一致。

### 5.4 UI 与图标

- 容器/弹层：`createStaticStyles` + `cssVar`（`colorBgElevated` / `colorBorderSecondary` / `borderRadiusLG`），与 `GoalPill` 统一。
- 图标（lucide-react）：分支 `GitBranch`、改动 `FileDiff`、图谱 `Network` 或 `GitGraph`（若可用）、创建分支 `GitBranchPlus`、后台任务 `ListChecks` / `Loader`（运行态旋转）、工作区 `FolderGit2`。
- 严格无 emoji。

## 6. 渐进实现顺序（建议拆分提交）

1. 后端：`get_git_branches` / `git_checkout` / `git_create_branch` + `lib.rs` 注册；`pi.ts` 桥接。
2. 前端：`BranchPicker`（分支切换 + 未提交改动数 + 创建并检出），先单独挂到 `zone` 验证。
3. `DiffPanel`（复用 `get_git_status` + `get_git_diff`）+ `ChangesButton`。
4. `TaskTray`（复用 `subagentList`）+ `TaskTrayButton`。
5. 后端 `get_git_log_graph` + `GitGraphPanel` + `GitGraphButton`。
6. `WorkspaceBar` 容器整合，统一布局 + overflow 折叠（参考 `ActionBar` 的 `resolveToolbarOverflow`）。

## 7. 风险与取舍

- git CLI 依赖：沿用现有 `run_git`（依赖系统 git），与现状一致。
- 大仓库性能：`status` / `log` 限制条数 + 懒加载 + 轮询节流；分支列表可缓存。
- diff 渲染：优先复用现有 diff 展示，避免重复实现。
- 刷新一致性：以 `agent_end` / `tool_execution_end` 事件驱动刷新，避免高频轮询。
- 后台任务边界：本期等同「子代理任务」(`subagent`)；若未来要纳入异步/服务端任务，再抽象统一的任务模型。

## 8. 视觉伴侣

随附 HTML mockup（深色，贴合 ZCode 主题，无 emoji），展示：功能栏静态形态、分支下拉、diff 面板、Git 图谱、后台任务托盘四个弹层。见同目录 `2026-06-17-workspace-git-bar-mockup.html`。
