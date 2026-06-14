# 子项目 C1：Checkpoint/快照 + 回滚 — 设计

- 日期：2026-06-14
- 状态：设计待审（brainstorming 产出）
- 父任务：GrenAgent / Pi agent 能力补全（A→B→C）。C = 借鉴 MiMo-Code/opencode 深度优化，拆为 **C1 checkpoint/回滚**、C2 上下文压缩增强、C3 workflow。本文档为 **C1**。
- 决策来源：brainstorming（2026-06-14，用户逐项确认）

## 1. 目标

为 GrenAgent 增加 opencode 式的**工作区快照 + 一键回滚（时间旅行）**：agent 每轮自动给工作区拍快照，用户可在「检查点」面板查看每个快照的文件 diff，并一键把工作区文件回滚到任一快照。GrenAgent 当前完全没有此能力。

核心价值：agent 改坏了文件时，无需手动 `git reset`/翻历史，直接回滚到改动前的检查点。

## 2. 关键决策（brainstorming 已确认）

| 决策点 | 选择 |
|--------|------|
| 实现方案 | **A：git 影子仓库 Pi 扩展**（独立 `--git-dir` + `--work-tree=cwd`，opencode `snapshot/` 同款；增量高效、自带 diff、不碰用户 `.git`）。否决 B（Rust 驱动，跨进程别扭）、C（复制式，无去重/占盘大） |
| 回退范围 | **只回退工作区文件**，对话保留不动（自洽、可做成 Pi 扩展、风险低）。不做 opencode 式「文件+对话」时间旅行 |
| 快照触发 | **每轮自动**（`before_agent_start` 拍一次；git 无变化则跳过，所以只对「改了文件的轮」生成 checkpoint）+ `/checkpoint create` 手动打点 |
| UI | 新建**「检查点」侧边模块**（时钟图标），ManagerLayout：时间线列表 + 选中看文件 diff + 一键回滚，与记忆/扩展面板一致 |
| diff 渲染 | **复用 shiki `LazyHighlighter`（unified diff，`language="diff"`）**，与 `ToolExecution` 一致、零新依赖。Monaco 并排 diff 留作后续可选增强（opencode 实际未用 Monaco；GrenAgent 已移除 Monaco 改用 shiki） |

## 3. 背景与现状

- **GrenAgent**：有上下文压缩（`CompactAction` + Pi 内置 compaction），但**无 checkpoint/snapshot/revert**。已有 `commands/git.rs` 的 `get_git_diff`（读用户仓库 diff，文本）。前端模块系统：`moduleStore`(ModuleId) + `ModuleRail`(图标按钮) + `ModuleContainer`(路由) + `ManagerLayout`(列表/详情)；diff 用 `LazyHighlighter`（shiki）。
- **opencode（MiMo-Code）`packages/opencode/src/snapshot/index.ts`**：git 影子仓库。要点（本设计复刻其思路，用 Node `child_process` 简化实现）：
  - 独立 `--git-dir <影子gitdir> --work-tree <cwd>`，快照对象/索引在用户仓库之外。
  - `track`：列改动（`diff-files`）+ 未跟踪（`ls-files --others --exclude-standard`），尊重源仓 `.gitignore`（`check-ignore --no-index`），跳过 >2MB 大文件，`add` 后 `write-tree`+`commit-tree` → 返回 hash；无变化返回 undefined。
  - `restore`/`revert`/`diff`。
  - Windows 安全 flag：`core.autocrlf=false`、`core.longpaths=true`、`core.quotepath=false`、`core.symlinks=true`。
- Pi 扩展 API：`pi.on("before_agent_start", ...)`（event 带 `prompt`）、`pi.registerCommand`、`ctx.cwd`、`ctx.ui.notify`。扩展跑在 bun sidecar，可 `child_process` 调 git（与 multi-agent spawn 同模式）。

## 4. 架构（三层）

### 4.1 扩展 `extensions/checkpoint/`

**`snapshot.ts`** — 影子仓库 git 封装（`child_process` 调 git），纯函数与 IO 分离便于测试：
- `gitArgs(gitdir, cwd, cmd[])`：拼装 `-c core.autocrlf=false -c core.longpaths=true -c core.quotepath=false -c core.symlinks=true --git-dir <gitdir> --work-tree <cwd> <cmd...>`（纯函数，可单测）。
- `parseNameStatus(out)`：解析 `git diff --name-status` → `{file, status}[]`（纯函数，可单测）。
- `ensureRepo(gitdir)`：`git --git-dir <gitdir> init -q` 若不存在。
- `track(gitdir, cwd): Promise<{ hash, files } | null>`：stage 改动+未跟踪（尊重源仓 .gitignore、跳过 >2MB）→ `write-tree` → `commit-tree`（父=上次 hash，可选）→ 返回 `{hash, files}`；无变化返回 `null`。
- `diff(gitdir, cwd, hash): Promise<string>`：`git diff <hash> -- .`（快照→当前工作区）的 unified diff 文本。
- `restore(gitdir, cwd, hash): Promise<void>`：`read-tree <hash>` + `checkout-index -a -f`，并删除「快照中不存在但当前存在」的跟踪文件，使工作区文件真正还原到该快照（仅限快照跟踪过的路径，避免误删无关文件）。

**`store.ts`** — 元数据持久化，复用 `extensions/_shared/sqlite.ts`（`bun:sqlite`/`node:sqlite` shim）：
- 库文件 `<cwd>/.pi/snapshots/meta.db`；影子 gitdir `<cwd>/.pi/snapshots/git`（`.pi` 建议加入 `.gitignore`）。
- 表 `checkpoints(id TEXT PK, hash TEXT, label TEXT, kind TEXT, files TEXT, createdAt INTEGER)`：`id` 短随机；`hash` 影子提交；`kind` `auto|manual`；`files` JSON（变更文件名+状态）。
- 方法：`add({hash,label,kind,files})`、`list(limit)`、`getById(id)`、`clear()`。

**`index.ts`** — 接线：
- `pi.on("before_agent_start", (event, ctx))`：`ensureRepo`；`track()`；若返回非 null（有变化）→ `store.add({ hash, label: prompt 摘要, kind:"auto", files })`。
- `pi.registerCommand("checkpoint", ...)`：
  - `list` → notify 列表
  - `create [label]` → `track()` 强制记一条（kind=manual；无变化也提示"无改动"）
  - `diff <id>` → `snapshot.diff(hash)` 输出
  - `revert <id>` → `snapshot.restore(hash)` + notify
  - `clear` → `store.clear()`（仅清元数据；git 对象保留，留待后续 prune）

### 4.2 Rust `src-tauri/src/commands/checkpoint.rs`（只读，与 memory 一致）

- `cp_list(workspace) -> Vec<CpItem>`：读 `<cwd>/.pi/snapshots/meta.db` 的 `checkpoints`（按 createdAt DESC）。`CpItem { id, hash, label, kind, files: Vec<...>, created_at }`（camelCase 序列化）。
- `cp_diff(workspace, id) -> String`：查 meta 取 hash，在影子仓库跑 `git --git-dir <.pi/snapshots/git> --work-tree <cwd> diff <hash> -- .`（带 Windows flag），返回 unified diff 文本。
- 变更（revert/create/clear）走 `/checkpoint ...` 命令（`pi.runCommand`），Rust 保持只读。
- 注册到 `src-tauri/src/lib.rs` 的 `invoke_handler`。

### 4.3 前端

- `stores/moduleStore.ts`：`ModuleId` 加 `'checkpoints'`。
- `features/layout/ModuleRail.tsx`：加「检查点」按钮（lucide `History` 时钟图标）。
- `features/workspace/ModuleContainer.tsx`：`case 'checkpoints'` → `<CheckpointsPanel />`。
- `features/checkpoints/CheckpointsPanel.tsx`（新）：`ManagerLayout`。
  - 列表：时间线，每条 `label`（轮 prompt 摘要/手动名）+ 时间 + kind 徽标 + 变更文件数。
  - 详情：选中 → `pi.cpDiff(workspace, id)` → `LazyHighlighter language="diff"` 渲染；顶部「回滚到此」按钮（`window.confirm` 后 `pi.runCommand(workspace, '/checkpoint revert <id>')` → reload）。
- `lib/pi.ts`：加 `CpItem` 类型 + `cpList(workspace)` / `cpDiff(workspace, id)` 绑定（camelCase 参数）。

## 5. 数据流

```
每轮 before_agent_start
  → snapshot.ensureRepo + track()（无变化跳过）
  → store.add(checkpoint 元数据) + git 影子提交
面板：CheckpointsPanel → RPC(cp_list / cp_diff) → 时间线 + 文件 diff(shiki)
回滚：选中 → /checkpoint revert <id> → snapshot.restore(hash) 还原工作区文件 → reload
```

## 6. 错误处理

- git 不存在/命令失败：该次快照跳过 + `ctx.ui.notify` 警告，不影响 agent 正常运行。
- `track` 无变化：返回 null，不记 checkpoint（避免空检查点）。
- `revert` 不存在的 id：notify warn。
- 大文件（>2MB）/被源仓 `.gitignore` 的文件：跳过快照。
- `.pi/snapshots` 损坏：`ensureRepo` 重建（旧元数据可能失效，提示）。
- restore 仅在快照跟踪过的路径范围内增删，避免误删工作区无关文件。

## 7. 测试策略

- `snapshot.test.ts`：`gitArgs`/`parseNameStatus` 纯函数单测；真实 git 临时目录集成：`track→改文件→track→diff→restore` 往返还原、跳过 >2MB、尊重 `.gitignore`。
- `store.test.ts`：`add/list/getById/clear` + 迁移（首次建表）。
- Rust：`cp_list`（读临时 meta.db）+ `cp_diff`（临时影子仓库）。
- 前端：`CheckpointsPanel`（mock `pi.cpList/cpDiff/runCommand`：渲染时间线、点 diff、回滚调用 `/checkpoint revert`）；`ModuleRail`/`ModuleContainer` 路由含 checkpoints。
- 集成：`build-sidecar.mjs` 重建 + 启动冒烟。

## 8. 实现顺序（交给 writing-plans 拆 phase）

`C1-1 snapshot.ts(git 影子仓库) → C1-2 store.ts(元数据) → C1-3 index.ts 接线+/checkpoint 命令 → C1-4 Rust cp_list/cp_diff → C1-5 前端 CheckpointsPanel+模块接入 → C1-6 重建冒烟`

每 phase TDD（红→绿→重构）+ commit。

## 9. 文件清单

**新增**：
- `extensions/checkpoint/{snapshot.ts, snapshot.test.ts, store.ts, store.test.ts, index.ts, package.json, README.md}`
- `tauri-agent/src-tauri/src/commands/checkpoint.rs`
- `tauri-agent/src/features/checkpoints/{CheckpointsPanel.tsx, CheckpointsPanel.test.tsx}`

**修改**：
- `extensions/index.ts`（注册 checkpoint 到 allExtensions）
- `tauri-agent/src-tauri/src/lib.rs`（注册 cp_list/cp_diff；mod checkpoint）
- `tauri-agent/src-tauri/src/commands/mod.rs`（如需声明 module）
- `tauri-agent/src/stores/moduleStore.ts`、`features/layout/ModuleRail.tsx`、`features/workspace/ModuleContainer.tsx`
- `tauri-agent/src/lib/pi.ts`

## 10. 非目标（YAGNI）

- 不回退对话（files-only；对话时间旅行留待后续）。
- v1 不做单文件选择性回滚（整快照还原；后续可加勾选）。
- 不引入 Monaco 并排 diff（先 shiki unified diff；Monaco 留作后续可选增强）。
- 不跨会话/无远程同步；不做自动 prune（可后续加 7 天/容量上限，参考 opencode）。
