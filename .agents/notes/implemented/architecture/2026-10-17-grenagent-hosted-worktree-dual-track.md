# Agent Note: GrenAgent 托管 Worktree 模式（双轨）

Status: implemented

## Problem

GrenAgent / Pi harness 原有显式工具 `create_worktree`（B 轨），能在仓库内建 checkout 并把**当前会话的 cwd**切过去，但**权限根仍绑主仓原始目录**：

- 工具注册与文案：`extensions/working-directory/index.ts:71-112`——checkout 落在 `<repository>/.agents/worktrees/<name>`；`writableRoot: projectCwd(ctx)`。
- Git 实现：`extensions/working-directory/worktree.ts:14`（`WORKTREE_POOL`）、`:183-226`（`createWorktree`）。
- 权限根语义：`extensions/_shared/session-cwd.ts` 头注释与 `projectCwd`（`:46-54`）。
- [子代理重新设计](2026-10-11-subagent-redesign.md) 的 worktree 段也写明这是「弱隔离」。

这与 Codex / Claude Desktop 一类「独立工作区 = harness 级隔离」不对齐：用户选独立工作区时期望**写主仓直接非法**，而不是靠模型自觉。

评审初稿（2026-10-18）时对照代码，初稿的「`git worktree` + open 参数 `isolation`，插在 `openInteractive` / `createWorkspaceHandle` 之前」走不通：

- "workspace" 同时是 `AgentHost` 的键（每个 workspace 一个前景 handle，`electron-agent/electron/agent/agentHost.ts:77-91`）、会话头 cwd、`projectCwd` 权限根。同项目新建会话走 `handle.newSession()`（`electron-agent/electron/app/piRuntimeService.ts:862`），不经过那两处；`listSessions` 只列 header cwd 等于 workspace 的会话（`workspaceService.ts:154`）。会话级覆盖权限根等于改 `projectCwd` 的全部消费方（20 个文件、57 处）。
- `git worktree` 的元数据在主仓 `.git/worktrees/<id>` 与共享的 `objects` / `refs`，在 worktree 目录外；`SandboxPolicy` 只有一个 `workspaceRoot`，沙箱下 `git commit` 会被拒。给 `.git` 开写又把主仓 refs / hooks / config 交给模型（[Windows 沙箱工作区配置保护](../bug-fix/2026-10-13-windows-sandbox-workspace-config-protection.md) 已证明 `.git` 靠 ACL 护不住）。
- 写出工作区原本只是 `builtin.outside-workspace-write`，`effect: 'ask'`，full 档是空集；bash 的 `sandbox_permissions: danger-full-access` 经用户批准能写任意路径。

## Decision

A / B 双轨并存，隔离级别在文档与 UI 上分开标注。A 轨由宿主托管：建、回传、删除、回收都是宿主调 git，写闸在 safety 与 sandbox 里，入口、侧栏归属、管理与只读查看在渲染层。

### A 轨：宿主托管的本地克隆，作为独立 workspace 打开

- `IsolatedWorkspaceService`（`electron-agent/electron/app/isolatedWorkspaceService.ts`，主进程）在 `<repo>/.gren/worktrees/<id>/` 执行 `git clone --no-hardlinks --no-checkout`，再在克隆里 `checkout -b gren/<id> <base>`。`.git` 在 W 内部，提交、分支、对象都在 W 里。所有 git 走 `runSafeGit`（hooks / fsmonitor 关、工作区定义的 filter 置空），checkout 带 `GIT_LFS_SKIP_SMUDGE=1`。
- `--no-hardlinks` 是必须的：硬链接的对象文件与主仓共用一份文件（Windows 上共用一份 DACL），沙箱给 W 授写权会让主仓对象也可写。实测默认 clone 的对象文件 `nlink` 为 2，`--no-hardlinks` 为 1。
- W 作为独立 workspace 打开（现有 `open_workspace(W)`），会话头 cwd = W，`projectCwd` = W；safety / 沙箱 / 审批的根自然是 W，`projectCwd` 的消费方一处不改。
- 克隆的 `origin` 指向主仓路径。模型在 W 里 `git push origin` 要写主仓 `.git`，沙箱根外，被拒。
- 限制：项目必须是仓库根；A 轨里不能再建 A 轨；数量上限默认 15（`DEFAULT_ISOLATED_LIMIT`，设置页 `isolatedWorkspaceLimit` 可改，每次创建现读），超过报错。失败时删掉本次建出的 W 和 marker，不留半成品。
- 创建成功后在主仓 `.git/info/exclude` 追加一行 `/.gren/`（只追加、已有就跳过）：代码索引这类只认根忽略规则的工具也跳过池目录。这是宿主唯一一次写主仓的 `.git`。

### 身份：路径结构 + 主仓里的 marker

`extensions/_shared/isolated-workspace.ts` 由主进程与 agent-host 共用。workspace 的规范路径形如 `<P>/.gren/worktrees/<id>`，且 `<P>/.gren/worktrees/<id>.json` 存在、内容里的 `id` / `parentRoot` / `path` 对得上，才算 A 轨（`isolatedWorkspaceOf`）。marker 和 W 平级、在 W 外，模型在 W 里改不到；W 里的任何文件都不参与判断。确认过的结果按规范路径缓存；命中缓存时仍确认 marker 文件在，删除后立即失效（主进程长驻，不这样侧栏要等重启才标「已删除」——端到端测出来的）。未确认的不缓存。`isolatedPathParts` 只按字符串判断形状（目录不在也能判），渲染层 `src/lib/isolatedWorkspace.ts` 用同一条规则。

marker 格式（落盘契约，`version: 1`）：

```json
{ "version": 1, "id": "51c67c69", "path": "<W>", "parentRoot": "<P>", "branch": "gren/51c67c69",
  "base": { "kind": "fresh", "ref": "origin/main", "commit": "<sha>" },
  "createdAt": "<ISO>", "createdBy": "grenagent",
  "carried": { "tracked": true, "untracked": 2 } }
```

`carried` 可选，只在创建时带入了主仓未提交改动时写。

`id` 只能是小写字母、数字、连字符（`^[a-z0-9][a-z0-9-]{0,63}$`），它同时是目录名、marker 文件名和分支名的一段。池目录首次创建时写自忽略的 `.gitignore`（`*`），不改用户仓库根上的 `.gitignore`。

### 写闸（must，与审批档无关）

- **safety 第 ① 层**（`extensions/safety/index.ts`，在 RPC 授权之前，full 档和用户规则都越不过）：A 轨会话里 write / edit / 绕过白名单的写盘工具，目标按 `resolve(ctx.cwd, path)` 后再「最近存在的祖先取 realpath + 剩余段」解析（`resolveRealTarget`），落在 `<P>` 内、W 外 → 硬拒绝（`writesIntoParent`）。junction / 符号链接指回主仓同样拦下；`working_directory` 切进主仓后，相对路径按当前目录解析照样拦。bash 带 `sandbox_permissions: danger-full-access` → 硬拒绝，不问人。
- **sandbox**（`extensions/sandbox/index.ts`）：`getPolicy` 对 A 轨把 `danger-full-access` 钳到 `workspace-write`，并在策略上标 `fullAccessBlocked`。`approveEscalation` 遇到 `fullAccessBlocked` 时拒绝升到 full-access（safety 预批过也不行），`canOfferEscalation` 在 workspace-write 起步时不再提示可升权；`operations.exec` 对 `PI_SANDBOX_MODE_ONCE` 的单次放宽同样封顶。read-only → workspace-write 的升权照旧走审批。

### Base

- 默认 `fresh`：主仓远端默认分支 tip（`refs/remotes/<remote>/HEAD` 指向的分支）。remote 取 `origin`，没有 `origin` 但只有一个 remote 时用它。`fetch: true` 时先 `git fetch --no-tags <remote>`。
- 没有 remote、多个 remote 且无 `origin`、`<remote>/HEAD` 未设置、fetch 失败：报错并给出改法（`git remote set-head <remote> --auto` 或改选 head），**never** 静默落到本地 HEAD。
- `head` 只在显式选择时使用，`base.ref` 记分支名（游离时为 `HEAD`）。

### 主仓未提交的改动：默认不带，可选「复制」带入

默认 leave。创建时勾「把主仓未提交的改动复制进去」（`carryChanges`）：宿主只读主仓，取 `git diff HEAD --binary` 在 W 里 `apply --3way` 后 `reset` 成未暂存，未跟踪文件（`ls-files --others --exclude-standard`，跳过 `.gren/` 和非普通文件）逐个复制。主仓工作树、暂存区、stash 都不动。fresh 基准上应用失败（多半是与基准冲突）就放弃创建、清理 W，报错建议改选 head；**never** 留下半应用的副本。

### 回传

`syncBack(project, id)` 在主仓执行 `git fetch -- <W> refs/heads/gren/<id>:refs/heads/gren/<id>`，不加 `+`：只快进，分叉或主仓检出了该分支时 git 报错原样抛出。

### 状态、删除与回收

- `state(project, id)`：`dirty`（W 有未提交改动）、`ahead`（分支比基准多几个提交）、`synced`（没有新提交，或主仓已有 `gren/<id>` 且包含 W 的 tip）、`lastActivity`（W 的 HEAD reflog / index mtime，拿不到用 createdAt）。
- 删除顺序：IPC 层先查 `listRunningTurns`，W 里有会话在跑 → `ISOLATED_BUSY`；没 force 且 dirty 或未回传 → `ISOLATED_UNSAVED`（在关 handle 之前判，免得关了才拒）；再 `WorkspaceService.releaseWorkspace`（收口子代理、关 handle、释放注册表，**不删**会话文件）；最后 service 先删 marker 再删 W。主仓的 `gren/<id>` 分支保留。
- 自动回收（`reclaim`）：启动时、开窗口之前跑完（此刻没有会话打开）。只删超过 `isolatedWorkspaceReclaimDays`（默认 30，0 = 关）没动过、不 dirty、已回传的；目录已被手动删掉的只清 marker。先用文件时间粗筛，未到期的不跑 git。
- W 删除后，会话 jsonl 还在：侧栏用 `isolated_workspace_probe` 判出 `missing`，行上标「已删除」，点会话打开只读查看（`subagent_get_session_messages` 读 jsonl → `ChatMessageItems`），不再 switchSession。

### 界面

- 侧栏：`buildProjectGroups` 把 W 的组接在父项目后面（父项目自己的排序不变），默认名 `gren/<id>`，父项目不在列表里时前缀父项目名；`ProjectItem` 缩进、分支图标、「独立」/「已删除」标签。普通项目菜单多「在独立工作区中新建会话…」「管理独立工作区…」；W 的菜单是「回传分支到主仓」「删除独立工作区…」，没有「再建独立工作区」。
- 新建弹窗（`src/features/isolatedWorkspace/IsolatedWorkspaceDialogs.tsx`）：默认 fresh；「基于当前 HEAD」收在「其他基准…」后面，选中时显示「和主线重叠时更容易冲突」；fetch 默认值来自设置页 `isolatedWorkspaceFetch`，head 下不可选；主进程报错原文显示在弹窗里，不自动改选。创建成功后走与「使用现有文件夹」同一条 `openProjectAt`。
- 管理弹窗：每条显示分支、基准、创建日期、是否带入改动和状态标签；回传、打开、删除。dirty 或未回传的删除要「仍然删除」二次确认才带 force；只列合格 marker，脚注写明 `.agents/worktrees` 和手建目录不在这里、也不能在这里删。
- 输入框下的 WorkspaceBar：在 W 里时工作区标签显示父项目名，多一个「独立工作区」标签（提示不能写主仓）和「回传」按钮。
- 文件浏览器按层列目录时跳过 `.gren`。B 轨工具卡标题改成「切到新 worktree · 仍可写原工作区」「切换目录」，不再显示原始工具名。
- 设置页「扩展与安全 → 独立工作区」：创建前 fetch、每个仓库上限、自动回收天数。

### IPC 契约

| 命令 | 参数 | 返回 |
| --- | --- | --- |
| `isolated_workspace_create` | `workspace`（主仓根），可选 `base: "fresh" \| "head"`、`fetch`、`carryChanges`（boolean） | marker |
| `isolated_workspace_list` | `workspace` | marker + `exists`，只列合格 marker |
| `isolated_workspace_state` | `workspace`、`id` | `{ id, exists, dirty, ahead, synced, lastActivity }` |
| `isolated_workspace_probe` | `paths: string[]` | `{ [path]: "active" \| "missing" \| "unmanaged" \| "none" }` |
| `isolated_workspace_sync_back` | `workspace`、`id` | `{ branch, commit }` |
| `isolated_workspace_remove` | `workspace`、`id`，可选 `force` | `{ removed: true }`；错误文本带 `ISOLATED_BUSY` / `ISOLATED_UNSAVED` |

非法 `base` / 布尔参数在 `electron-agent/electron/ipc/register.ts` 直接拒绝。渲染层包装在 `electron-agent/src/lib/pi.ts`。

### B 轨（不变）

`create_worktree` 只切换会话 cwd，权限根仍是会话的 `projectCwd`，路径仍是 `<repo>/.agents/worktrees/<name>`。它**不是** harness 级隔离。在 A 轨会话里它仍可用：`projectCwd` = W，checkout 落在 `<W>/.agents/worktrees/`，git 元数据在 W 的 `.git` 里，都在可写根内，也都受 A 轨写闸约束——这是选 clone 而不是 `git worktree` 的顺带结果。

### 与现有笔记的关系

- [子代理重新设计](2026-10-11-subagent-redesign.md)：B 轨的出处，本篇不推翻。
- [子代理激活与路由](2026-09-13-subagent-activation-and-routing.md)：历史路由背景。
- [宿主 git 加固](../bug-fix/2026-10-13-host-git-hardening.md)：create / syncBack 都走 `runSafeGit`，继承它的 TOCTOU 已知缺口。
- [Windows 沙箱工作区配置保护](../bug-fix/2026-10-13-windows-sandbox-workspace-config-protection.md)：不选 `git worktree` + 多根沙箱的依据之一。
- 对照 [FlashingChen/dsh-worktree](https://github.com/FlashingChen/dsh-worktree)（README 核对日 2026-10-18）：借鉴仓内根 + 每条记录 + 宿主调 git + 「注册 workspace 再开会话」；不照搬默认 HEAD、模型 mid-task 自建、无写闸、`git worktree` 形态。

## Alternatives considered

- **`git worktree add` + open 参数 `isolation`，在 `openInteractive` / `createWorkspaceHandle` 之前创建（初稿方案）** — 最强理由：和 B 轨同一套 git 机制，分支直接出现在主仓，不用回传；open 带一个枚举看起来改动最小。不用：新建会话不经过这两处；会话级权限根要改 `projectCwd` 全部消费方；元数据在目录外，沙箱下提交失败，开写又把主仓 refs / hooks / config 交给模型。
- **会话级覆盖权限根，workspace 仍是主仓** — 最强理由：侧栏、记忆、审批、子代理注册表都继续按主仓归属，用户心智最简单。不用：57 处 `projectCwd` 要区分「权限根」和「项目身份」，漏一处就是伪隔离。
- **保留 `git worktree`，沙箱改多根，只开 `.git/worktrees/<id>` + `objects` + 本分支 ref** — 最强理由：不用回传，磁盘不重复。不用：三个平台的 provider 都要支持多根；`objects` 可写仍能破坏主仓对象；锁文件与 ref 事务要的写权限比「本分支 ref」宽，ACL 收不窄。
- **保留 `git worktree`，A 轨禁止提交、由宿主代提交** — 最强理由：沙箱模型不变。不用：commit / rebase / stash 在 A 轨里全部失效，宿主要代理一整套 git 语义。
- **`clone --local`（硬链接）或 `--shared`（alternates）** — 最强理由：几乎不占额外磁盘、克隆瞬时完成。不用：硬链接共用文件和 DACL，沙箱授权会让主仓对象可写；alternates 在主仓 gc 掉不可达对象后会让 W 损坏。
- **marker 放在 W 里（如 `W/.git/gren.json`）或仓级单个 `manifest.json`** — 前者最强理由是自描述、跟着目录走；不用，W 是可写根，模型删掉它就解除写闸。后者最强理由是一个文件列全；不用，并发创建要锁或合并，每条一份 `<id>.json` 没有这个问题。
- **写主仓沿用 ask（只把默认根换成 W）** — 最强理由：保留用户临时放行的灵活性。不用：产品承诺是写主仓非法，一次误点就破；full 档下 ask 规则整个不生效。
- **把写闸做成主进程 toolPermission 的新内置规则** — 最强理由：规则、审计集中在一处。不用：内置规则按审批档分组，full 档为空集；新增 flag 要改事实契约（`FLAG_KEYS`、`desktop-control` 类型）。能力硬限本来就在 safety 第 ① 层，放在那里与「子代理 deny / readonly」同级。
- **整仓把权限根一律绑到 worktree** — 所有现有「主仓可写 + 可选 cwd」会话、沙箱预设、子代理继承规则都要重写，且会破坏 B 轨与不选独立工作区的日常路径。
- **仓外根（如 `E:/.codex/worktrees`）** — 用户判断意义不大；仓内根更易发现、与仓库生命周期一致，识别也能用路径结构 + 主仓 marker 做。
- **仅靠提示词让模型调用 `git worktree` / `create_worktree`** — 模型可能漏调、调完仍写主仓。
- **默认 base = `head`** — 表面省掉 fetch，但工作树叠在与主线重叠的 tip 上，后续 merge / PR 冲突面更大。
- **带未提交改动用「移动」（宿主 stash 主仓后在 W 里 apply）** — 最强理由：改动只存在一份，不会出现主仓和 W 各改各的。不用：宿主要改主仓工作树和 stash，apply 失败时还要把 stash 恢复回主仓，任何一步出错都可能丢用户的改动；「复制」只读主仓，失败只需删掉 W。代价是两边各有一份同样的未提交改动，用户自己决定主仓那份要不要清。
- **入口放在全局「新建项目」里** — 最强理由：W 本来就是一个 workspace，放在项目层级最诚实。不用：用户的心智是「在这个项目里开一个隔离的会话」，从全局入口要再选一次父项目。
- **侧栏把 W 当普通项目平铺** — 最强理由：零改动。不用：8 位 id 的目录名没有辨识度，主仓与 W 的关系只能靠路径猜。
- **自动回收不看是否已回传** — 最强理由：磁盘回收最积极。不用：未回传的分支只存在于 W，删了就丢工作。
- **W 删除后连会话一起删** — 最强理由：侧栏干净，不留打不开的会话。不用：会话里有做过什么、为什么这么做的记录，比目录更值得留；只读查看的成本很低（复用子代理的 jsonl 读取）。用户要清可以用会话菜单逐条删。

## Consequences

收益：

- 「写主仓非法」由两层兜住：工具写入在 safety 第 ① 层硬拒绝（含链接逃逸），bash 由 OS 沙箱拒（根 = W，full 档被钳）。不依赖模型自觉，也不依赖审批档。
- 沙箱里的 git 工作流完整可用：commit、branch、rebase 都只写 W 的 `.git`。
- `projectCwd` 的 57 处消费方不改；B 轨与普通项目的行为不变（单测覆盖「结构像但没有 marker」「B 轨目录」「普通项目 full 档」）。

代价与已知缺口：

- **磁盘与耗时**：`--no-hardlinks` 复制整个对象库，大仓库每个 A 轨一份完整副本；最坏是上限份数。靠上限、手动删除和自动回收兜；若实测不可接受，再评估 `--reference` + `repack -a -d` 解除 alternates（另开笔记）。
- **项目身份分家**：记忆、审批档、agent 模式、子代理注册表、`.pi` 配置都按 W 另起，主仓的「项目默认」不自动继承。
- **Windows 上 W 里读不到主仓时**，模型 `git fetch origin` 也会失败（端到端里 PiSandbox 读不到用户目录下的主仓）。主仓在数据盘、Authenticated Users 可读时不受影响。目前没有「把主线同步进 W」的宿主入口，需要时另开笔记。
- **MCP 写盘不受写闸约束**：MCP 服务器在沙箱外，事实层拿不到写入路径，仍按 `builtin.mcp` 处理。
- **宿主在 W 里跑 git**（文件树状态、syncBack 读 W）：W 的 `.git/config` 由沙箱写得到，受宿主 git 加固笔记里 TOCTOU 缺口的影响。
- **主仓那边的普通会话照样能写 W**（W 在主仓目录树里）；文件浏览器与 git 已忽略 `.gren/`，代码索引靠 `.git/info/exclude`（CodeGraph SDK 文档写明读它，未单独实测索引结果）。
- **两套目录（`.agents/worktrees` vs `.gren/worktrees`）** 易混淆；管理弹窗脚注写明「谁建的、谁能删」。
- **侧栏父子关系依赖路径**：主仓被移动 / 改名后 marker 里的路径失效，W 变成独立的孤儿项目（仍可打开，不再被识别为独立工作区，写闸随之失效）。
- **项目默认不继承**：用户在主仓设的审批档、agent 模式不带到 W；A 轨 full 档实际被钳到 workspace-write，界面上的档位文字不会说明这一点。
- **带入的改动在两边各一份**：主仓的未提交改动保持不动，回传后合并时可能和主仓那份撞上。
- **回收误判只会更保守**：「已回传」按主仓 `gren/<id>` 是否包含 W 的 tip 判；用户手动把主仓那条分支 reset 到更早时会判成未回传，不会删。

## 验证

| 项 | 命令 / 方式 | 结果 |
| --- | --- | --- |
| 识别、写闸判定（含 junction）、缓存随 marker 删除失效 | `cd extensions && npx vitest run _shared/isolated-workspace.test.ts` | 通过（9 项） |
| safety 硬拒绝、sandbox 钳模式与升权闸、B 轨回归、工具提示词元数据 | `cd extensions && npx vitest run _shared/isolated-workspace.test.ts safety sandbox _shared/sandbox working-directory prompt-metadata.test.ts` | 通过（35 文件 454 项，26 项 live 跳过） |
| 宿主 service（真 git：fresh / head / fetch / 携带改动与冲突放弃 / state / remove / force / reclaim / probe / 上限 getter / info/exclude / syncBack）、IPC（删除先拒 BUSY 和 UNSAVED 再关 handle）、WorkspaceService、文件浏览器 | `cd electron-agent && npx vitest run electron/app/isolatedWorkspaceService.test.ts electron/ipc/register.test.ts electron/ipc/commandCoverage.test.ts electron/app/workspaceService.test.ts electron/app/fileService.test.ts` | 通过（5 文件 80 项） |
| 渲染层（侧栏分组嵌套、项目行标签、菜单、WorkspaceBar 标签与回传、设置页 schema、工具卡） | `cd electron-agent && npx vitest run src/lib/isolatedWorkspace.test.ts src/features/sessions src/features/settings src/features/chat/input/workspace src/features/tools/ToolExecution.test.tsx` | 通过（31 文件 212 项） |
| 打开已删除工作区的会话改走只读查看、回传提示 | `cd electron-agent && npx vitest run src/features/isolatedWorkspace` | 通过（`actions.test.ts` 3 项） |
| UI 实跑 | `cd electron-agent && npm run ui:check -- isolated-workspace` | 通过（53 条断言）：父子归属与缩进、已删除标签、两类菜单、新建弹窗默认 fresh / head 次要带风险 / 报错原文不改选 / 携带改动、WorkspaceBar 标签与回传、管理弹窗状态标签、未回传删除二次确认带 force、已回传普通确认、只读查看、浅色主题 |
| 端到端（真实 Windows 沙箱 PiSandbox） | `pnpm exec tsx .agents/evidence/2026-10-17-grenagent-hosted-worktree-dual-track/e2e.live.mts` | 通过（19/19）：fresh 不取本地 HEAD；主仓 status 干净；full 档下沙箱 bash 写主仓 `Permission denied`、写 W 成功；沙箱里 `git commit` 成功；升权 full-access 被拒不执行；safety full 档写主仓被拒；A 轨里 `create_worktree` 可用且都在 W 内；syncBack 快进；回传后 state 为已回传；删除后目录与 marker 都没了、probe 为 missing、主仓分支保留、`.git/info/exclude` 有 `/.gren/` |
| 类型 | electron-agent `npx tsc -p tsconfig.node.json --noEmit`，以及临时 tsconfig 只含改动的渲染层文件 `npx tsc -p` | 新增 / 改动文件无报错；其余报错（主进程 156、渲染层 48）都在本次未改的文件里 |
| 全量回归 | `cd electron-agent && npx vitest run` | 部分通过：469 文件里 7 个失败。本篇的 `isolatedWorkspaceService.test.ts` 是全量负载下 `beforeEach` 搭仓库超过 10 秒 hook 超时，已给 hook 放宽到 60 秒后单独复跑通过；另外 6 个（`tencentdb/runtime`、`agentData/auditViewStore` / `jobCleanup` / `runtime`、`subagentService`、`taskViewService`）单独跑同样失败，文件与 HEAD 一致（例如 HEAD 里就没有 `tencentdb/runtime.ts`），与本篇无关 |

证据：`.agents/evidence/2026-10-17-grenagent-hosted-worktree-dual-track/`（`unit.log`、`e2e.live.log`、`e2e.live.mts`、`ui-check-isolated-workspace.log`、`shots/`）。端到端里「沙箱 push 回主仓没生效」那一条的原因是 PiSandbox 读不到临时目录下的主仓，不单独证明「写 `.git` 被拒」；写主仓被 OS 拒由 `escape.txt` 那条证明。没有在完整 App 里点一遍（侧栏 + 弹窗 + 打开 W 的整条用户路径）：仓库没有能起完整 App 的 verify skill。ui-harness 用真实组件和真事件覆盖了界面，主进程与沙箱由端到端覆盖，打开已删除会话的拦截抽成 `openReadonlyIfIsolatedGone` 单测覆盖；App.tsx 里 `openProjectAt` 与 `handleIsolatedDeleted` 两处接线没有自动化测试。
