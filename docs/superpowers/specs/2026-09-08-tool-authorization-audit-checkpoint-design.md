# Pi 工具授权、审计与变更撤销设计

日期：2026-09-08
状态：设计已确认，待用户审阅书面规格
适用范围：Pi Electron 版；`extensions/safety`、AgentData 持久化、Electron 主进程权限层、聊天 UI

## 1. 目标与边界

补齐三项能力：工具调用的审批队列、以 allowlist 规则实现的批量授权、以及工具执行的审计台账；并在其上提供文件变更汇总与磁盘级撤销。

授权时机采用混合策略。危险动作（bash、工作区外写、联网、MCP、宿主代码执行）在执行前拦截并等待授权；普通文件编辑先执行、事后汇总为一张可审查可撤销的变更卡。前者解决"不该做的别做"，后者解决"做错了能退回"。

本设计不改动 `PI_ALLOWED_EXTENSIONS` 的托管插件名单。`safety` 扩展在 `cli/src/extension-profile.ts:40` 是硬编码永不剔除的，新链路挂在它上面，因此不需要让 `approval`、`mcp-policy`、`agent-mode` 三个扩展在桌面端突然生效——那会改变现有的模式行为，属于另一件事。

首版明确规则：

- 授权决策的唯一权威在 Electron 主进程。sidecar 只负责拦截和提问，不持有规则。
- 决策失败一律 fail-closed，且按失败性质分两个方向：规则查询本身失败（SQLite 繁忙、单条规则解析异常）时降级为 `ask`，交给用户判断；决策通道整体不可用（`AGENT_DATA_ENDPOINT` 未配置或连接失败）时直接拒绝，因为此时既无法确认规则也无法写入审计，放行等于无记录地执行。绝不因为"查不到规则"而放行。
- 子代理能力硬限（`SAFETY_DENY_TOOLS` / `SAFETY_READONLY`）位于所有审批之上，任何用户授权都不能越过。
- 快照不使用 git，不读写用户仓库的 `.git`。

## 2. 现状：三条断掉的线

这不是从零新建，三处已有实现处于未接通状态。

**审批策略在桌面端是空操作。** `extensions/safety` 实现了完整的 `ask` / `auto` / `full` 三档策略，但 `getApprovalPolicy()` 的持久化在 `extensions/approval`，而主进程 `electron/app/piRuntimeService.ts:658` 注入的 `PI_ALLOWED_EXTENSIONS` 只放行 6 个托管插件，`approval` 不在其中。输入框底部的"完全访问"下拉切换后前端 store 变了，sidecar 内的策略始终是默认的 `auto`。

**主进程的 ask 分支是死路。** `electron/app/permissionManager.ts` 有 `allow | deny | ask` 三态和挂起-恢复的骨架，但 `builtin()`（46–56 行）永不返回 `ask`，`main.ts:69` 创建时未注入任何 provider，`authorize()` 遇到 `ask` 立即返回 `blocked` 而不等待。渲染层 `PromptRequestCard` 里的 `source === 'permission'` 分支全仓库找不到生产者。

**审计表建了但零写入。** `electron/agentData/storage.ts:15` 的 `audit_events` 没有任何 INSERT，`ItemType` 中的 `permission_request`（`appServer/types.ts:36`）同样没有写入路径。现有 `agent_audit` 记录的是后台任务与知识库操作，不是工具执行。`items` 表的 `tool_call` 只存终态，且无授权决策信息。

UI 侧没有跨工具的变更聚合，每条 `edit` / `write` 各自渲染一行 `ToolExecution`；`GitFileStatus` 只有 `path` 与 `status`，没有行数统计。

## 3. 授权链路

### 3.1 主链路

```
sidecar  extensions/safety 的 tool_call 钩子（preflight 阶段）
   │
   ├─ ① 子代理能力硬限：保留现有逻辑，位于一切审批之上
   │
   ├─ ② 快问主进程（desktopControl TCP，5 秒内必返回）
   │      permission.evaluate { tool, args, workspace, sessionId, toolCallId, origin }
   │      主进程：匹配 permission_rules → 写 tool_audit → 返回 allow | deny | ask
   │
   ├─ allow → return undefined
   ├─ deny  → return { block: true, reason }
   └─ ask   → 按是否有 UI 分流
        │
        ├─ ctx.hasUI 为真
        │    await ctx.ui.input(JSON.stringify({ __approval: 1, request }), undefined, { signal })
        │    主进程 onUiRequest → pi://ui-request → 渲染层识别 __approval 哨兵 → 审批卡
        │    用户选「总是允许」时，渲染层另发 permission_rule_upsert 写规则
        │    答案经 extension_ui_respond 回到钩子，据此放行或 block
        │
        └─ ctx.hasUI 为假（Goal 后台轮次、子代理）
             permission.enqueue 登记 pending 后立即 block
             reason 为「已攒起等待授权」；Goal 标记 blocked 不空转
             用户回来处理后可 resume
```

`ctx.ui` 协议本身不能承载结构化数据。`extensions/agent-mode/index.ts:245-250` 已有先例：把整张卡的 JSON 塞进 `ctx.ui.input` 的 title，前端识别哨兵后渲染富卡。审批卡复用同一模式。这条通道无超时且支持 `signal` 中断，正是长时间等待人类所需要的。

`desktopControl` 走的 TCP 通道不能用于等待用户。`extensions/memory/client.ts:12` 的 `MemoryClient` 硬编码 5000ms 超时，且 `desktop-control.ts:22` 的 catch 把超时转成 `denied`。因此该通道只承担规则查询这类快操作，等待人类交给 `ctx.ui`。

### 3.2 safety 四层结构的调整

现有钩子的四层中，① 保留不变，②③④ 全部替换为快问主进程：

| 层 | 现状 | 调整后 |
| --- | --- | --- |
| ① 子代理能力硬限 | `SAFETY_DENY_TOOLS` / `SAFETY_READONLY` 直接 block | 不变，仍在审批之上 |
| ② `full` 跳过确认 | 进程内变量判断 | 成为主进程的一套内置规则预设 |
| ③ `ask` 逐次确认 | 硬编码 `ctx.ui.select` | 由主进程规则匹配结果驱动 |
| ④ 危险命令与受保护路径 | 硬编码规则 + `ctx.ui.select` | 危险命令成为内置 `ask` 规则，受保护路径成为内置 `deny` 规则，设置页均可见 |

`ask` / `auto` / `full` 重新定义为主进程规则集的三个预设，语义与现状保持一致，但规则内容对用户可见、可查询、可追溯。危险命令与受保护路径从不可见的硬编码变成可见的内置规则，用户能知道自己为什么被拦。

内置规则是代码常量，不写入 `permission_rules` 表。匹配时先取当前预设对应的内置规则集，再叠加表中的用户规则，按第 4.1 节的优先级合并。设置页对内置规则只读展示，用户不能删除或编辑——安全护栏不应该被误删。用户可以针对具体场景添加更窄的规则，但优先级保证了用户的 `allow` 既解除不了内置的 `deny`，也降不掉内置的 `ask`：危险命令始终要逐次确认，受保护路径始终禁止。

### 3.3 队列语义

`cli/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:784` 说明：同一条 assistant 消息的兄弟工具调用「顺序 preflight，然后并发执行」。`tool_call` 钩子跑在 preflight 阶段，第一个钩子一旦阻塞等待用户，后续兄弟调用不会 preflight，因此**无法在一次拦截中收齐同轮的多个待授权动作**。

采用渐进累积卡：同一 turn 内共用一张卡，第一条待批准动作出现时渲染，用户处理后下一条追加为新行。视觉上是多行列表，行为上逐行点亮。Cursor 与 Cline 同样逐个询问，这是 SDK 层面的固有约束，不是妥协。

"一次看到多个动作"的体验由第 5.3 节的变更汇总卡提供，那张卡是事后聚合，不受 preflight 顺序限制。

## 4. 数据模型

全部落 `agent-data.db`，在 `electron/agentData/storage.ts` 的 `migrate()` 中建表，`schema_version` 从 3 升至 4。

```sql
CREATE TABLE IF NOT EXISTS permission_rules (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,                -- session | workspace | global
  scope_key TEXT NOT NULL DEFAULT '', -- session_id 或工作区路径，global 为空
  tool TEXT NOT NULL,                 -- 工具名，mcp__server__* 支持尾部通配
  matcher_kind TEXT NOT NULL,         -- any | command_prefix | path_glob | mcp_server
  matcher TEXT NOT NULL DEFAULT '',
  effect TEXT NOT NULL,               -- allow | deny | ask
  created_at INTEGER NOT NULL,
  expires_at INTEGER                  -- NULL 为永久
);
CREATE INDEX IF NOT EXISTS permission_rules_lookup ON permission_rules(scope, scope_key, tool);

CREATE TABLE IF NOT EXISTS tool_audit (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  session_id TEXT, thread_id TEXT, turn_id TEXT, tool_call_id TEXT,
  origin TEXT NOT NULL,               -- main | subagent | goal
  tool TEXT NOT NULL,
  args TEXT NOT NULL,                 -- 按工具裁剪后的摘要
  decision TEXT NOT NULL,             -- allow | deny | ask
  resolution TEXT NOT NULL,           -- auto | rule | user_allow | user_deny | queued | aborted
  rule_id TEXT,
  queue_payload TEXT,                 -- 仅 queued 行有，渲染卡片所需
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS tool_audit_session ON tool_audit(session_id, created_at);
CREATE INDEX IF NOT EXISTS tool_audit_pending ON tool_audit(resolution, created_at) WHERE resolution = 'queued';

CREATE TABLE IF NOT EXISTS file_checkpoints (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL, session_id TEXT, turn_id TEXT NOT NULL, tool_call_id TEXT,
  path TEXT NOT NULL,
  before_blob TEXT,                   -- 内容哈希，NULL 表示文件原本不存在
  after_hash TEXT,                    -- 撤销前用它校验文件是否被外部改过
  additions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  reverted_at INTEGER
);
CREATE INDEX IF NOT EXISTS file_checkpoints_turn ON file_checkpoints(turn_id, created_at);
```

### 4.1 规则匹配

优先级按 effect 强度：`deny` 压过 `ask`，`ask` 压过 `allow`。同强度下 scope 越窄越优先，`session` 压过 `workspace` 压过 `global`。这样会话内的临时放行不污染全局，全局的一条 deny 也不会被会话级 allow 绕过。过期规则（`expires_at` 已过）不参与匹配。

三档 effect 对应三种护栏强度，缺一不可：`deny` 是不许做（受保护路径写入），`ask` 是必须问（危险 bash 命令，用户可以逐次放行但不能配置成自动放行），`allow` 是放行。若只有 `deny` 与 `allow` 两档，不可删除的内置规则就只能在"永远禁止"和"可被用户规则覆盖成静默放行"之间二选一，两者都不是现有行为。

`matcher_kind` 决定参数比对方式：`any` 只看工具名；`command_prefix` 用于 bash，比对命令前缀；`path_glob` 用于 write / edit，比对目标路径；`mcp_server` 匹配 `mcp__<server>__*` 整个服务器。

### 4.2 审计范围

`tool_audit` 记录授权决策，不重复记录执行结果——后者已在 `items` 表的 `tool_call` 中，靠 `tool_call_id` 关联。

`args` 存裁剪后的摘要而非原始参数，每个工具一个摘要函数。bash 存完整命令，这是审计的主要价值所在；write / edit 只存路径，内容动辄几十 KB 且已在快照 blob 中。

不复用 `storage.ts:15` 已有的 `audit_events`：它的字段是 `{event, payload}` 这类通用形态，无法支撑"列出本周所有 bash 执行"这类查询。该表是既有死代码，本设计不删除它。

### 4.3 队列不单独建表

"待审批"是审计行的一个状态，`tool_audit.resolution = 'queued'` 加上部分索引即可。单独建表会让同一份状态在两处流转，得不偿失。

### 4.4 快照存储

blob 按内容哈希落 `userData/checkpoints/blobs/<hash 前两位>/<hash>`，内容寻址天然去重。不进 SQLite——`node:sqlite` 存大 blob 会拖慢主库。

回收靠引用计数：`file_checkpoints` 中引用该哈希的行数归零即删除 blob 文件。

## 5. 子项目划分

三个子项目，S1 是 S2 与 S3 的共同前置，S2 与 S3 互不依赖。每个子项目各自走规格、计划、实现周期。

### 5.1 S1 授权中枢与审计台账

建立完整的拦截、决策、审计链路，UI 复用现有 `PromptRequestCard`，不做新组件。

改动现有文件：`extensions/safety/index.ts`（钩子插入快问，②③④ 层替换）、`extensions/_shared/desktop-control.ts`（新增 RPC 客户端方法）、`electron/main.ts`（在 `methods` 中注册 RPC）、`electron/agentData/storage.ts`（建表升版本）、`src/features/extensionUi/ExtensionUiHost.tsx` 与 `src/features/chat/input/PromptRequestCard.tsx`（识别 `__approval` 哨兵）。

新建六个主进程模块：规则匹配纯函数、内置规则常量、规则存储、审计存储、参数摘要、决策服务。

`PermissionManager` 保持原样，不加 provider 也不启用其挂起分支。审批的等待发生在 sidecar 的 `ctx.ui.input` 上，主进程只做规则查询后立即返回，用不到主进程侧的挂起 Promise，也用不到 `permission_resolve`。`PermissionManager` 继续负责 `mcp.call`、`network.request` 这类 operation 的 profile 级硬限，与工具授权链路职责不重叠。第 2 节列出的三处死代码中，本设计只激活「渲染层识别结构化 UI 请求」这一处；另外两处（`PermissionManager` 的 ask 挂起、`PromptRequestCard` 的 `source: 'permission'` 分支）仍然是死代码，本设计不删除也不使用它们。

### 5.2 S2 审批队列与批量授权

在 S1 链路上加队列语义与批量操作 UI。

新建：审批队列 store、审批卡组件、设置页的规则管理面板。审批卡外壳用现成的 `ConvCard`，选项行用现成的 `QuestionSelector`，不另起一套视觉。

"总是允许"落成 `permission_rules` 一行，作用域由用户在卡片上选择。设置页可查看、编辑、删除规则，并通过 `tool_audit.rule_id` 展示每条规则的命中情况。

### 5.3 S3 文件快照与变更撤销

`tool_call` 钩子对 `write` / `edit` / `ast_edit` / `hl_edit` 在执行前 capture 原文件内容，`tool_result` 事件后计算 `after_hash` 与行数差。同一 turn 的记录聚合为一张变更汇总卡，每行一个文件，显示路径与 `+N -M`，支持单文件撤销与整轮撤销。

每行两个操作：「审查」在卡内展开该文件的行级 diff，复用现有 `EditPreview` 的渲染；「打开」调用现有的在编辑器中打开文件的 IPC，定位到首个变更行。两者都不修改文件。

撤销前校验当前文件哈希等于 `after_hash`。不等说明文件被外部修改过，提示用户确认而不静默覆盖。

`before_blob` 为 NULL 表示文件原本不存在，撤销即删除该文件。

## 6. 关键技术约束

**并发写入与文件队列。** `docs/extensions.md:1923` 要求任何改文件的工具都使用 `withFileMutationQueue()` 参与 per-file 队列，否则并发工具会读到同一份旧内容并互相覆盖。快照的 capture 也必须进入该队列，否则会拍到被其他并发工具改过的中间态。

**中断清理。** 用户点停止时，`ctx.ui.input` 的 `signal` 会中断挂起的审批。`tool_audit` 中对应行必须置为 `aborted`，不能留下永远 pending 的记录。

**超时方向。** `permission.evaluate` 必须在 5 秒内返回，而 SQLite 的 `busy_timeout` 是 1000ms（`storage.ts:8`）。数据库繁忙导致查询失败时降级为 `ask`；TCP 连接失败或超时按第 1 节的规定直接拒绝——`desktop-control.ts:22` 现有的 catch 已经返回 `denied`，方向正确，新代码保持。

## 7. 业界方案对照

快照方案的选择基于对三家实现的查证，结论是不使用 git。

**Cursor** 不用 git。checkpoint 存 `globalStorage/state.vscdb` 的 `cursorDiskKV` 表，key 为 `checkpointId:{composerId}:{checkpointId}`，另有 `composer.content.{hash}` 做内容寻址 blob 跨会话去重，恢复时直接覆盖编辑器 buffer。官方明确说明 checkpoints 与 git 分离，不使用 `git stash` 或 `git reset`。

**Cline** 用影子 git 仓库，但 git 目录在工作区外：`globalStorage/checkpoints/{cwdHash}/.git`，配 `core.worktree` 指向用户工作区，用户自己的 `.git` 不受影响。代价是必须处理嵌套 git 仓库——暂存前把子仓库的 `.git` 临时改名为 `.git_disabled`，崩溃后还要清理残留。

**Codex** 官方无此能力。实验性的 `/undo` 因设计问题被移除。Codex Desktop 曾把全树 checkpoint 作为 git 对象写进用户仓库的 `refs/codex/turn-diffs/`，结果是 issue #29388 报告 5.7 GB 项目产生 102 GB 孤儿对象（无 GC），issue #28241 是非标准 refs 导致 libgit2 客户端崩溃。第三方替代 `codex-rewind` 回到 Cursor 路线：内容寻址 blob 加 manifest 存 `CODEX_HOME/file_snapshots/`，restore 只写文件内容，从不调用 git。

选择内容寻址 blob 的直接理由：省磁盘不需要 git。哈希去重的效果与 git object store 相同，却没有 git 带来的条件分支——非 git 工作区、被 `.gitignore` 的文件、rebase 中途、嵌套仓库，这些全都不必处理。而被 `.gitignore` 的文件（`.env`、构建产物）恰恰是误改后最难恢复的。

## 8. 待验证项与风险

按严重程度排列。前两项须在 S1 动工前验证，结论可能反过来修改本设计。

**子代理的审计归属未验证。** 子代理是独立 sidecar 进程，其 `AGENT_DATA_ENDPOINT` 是否指向同一个主进程实例尚未确认。若不是，子代理的审计与队列写不进主库，"子代理并发请求进入队列"这条需求落不了地。

**preflight 阶段拍快照的安全性未验证。** 按文档推理，兄弟调用先全部顺序 preflight 再并发执行，因此 preflight 时没有工具在跑，capture 是安全的。但跨 assistant message 以及子代理跨进程写同一文件时该前提不成立。须写并发测试确认，不能只依据文档措辞。

**内置规则预设的行为等价性。** 把 `ask` / `auto` / `full` 三档从进程内变量迁移为主进程规则集时，必须保持现有语义。特别是 `full` 档下子代理能力硬限仍然生效这一条。

**磁盘占用无上限。** 首版不设保留策略，长期使用后 `checkpoints/blobs` 会持续增长。清理策略在 S3 规格中单独定义。

## 9. 验证标准

S1 完成的判据：

- 规则匹配单测覆盖四种情形：`deny` 压 `ask` 压 `allow`、同强度下窄 scope 压宽 scope、过期规则不命中、用户 `allow` 无法覆盖内置 `deny` 与内置 `ask`。
- 每一次工具调用在 `tool_audit` 中都有对应行，`decision` 与 `resolution` 组合正确。
- 在 `ask` 档下执行一条 `bash npm run build`，确认卡片出现、批准后执行、审计留痕。
- 两条失败路径方向正确：断开 AgentData endpoint 后执行需授权工具确认拒绝；模拟 SQLite 繁忙时确认降级为询问而非放行。
- `full` 档下子代理能力硬限仍然生效：给子代理注入 `SAFETY_DENY_TOOLS` 后，即使主会话为 `full`，该工具仍被拦截。

S2 完成的判据：

- 同一 turn 内连续两个待批准动作，第二条追加至同一张卡而非新建。
- 点击「总是允许」并选择命令前缀后，第二次同类命令不再询问，审计中 `resolution` 为 `rule`。
- Goal 后台轮次遇到需授权动作时标记 blocked，人工处理后可 resume。

S3 完成的判据：

- blob 去重与引用计数回收的单测。
- 撤销前哈希校验：文件被外部修改时提示而非静默覆盖。
- 一轮修改 4 个文件，卡片显示正确的 `+N -M`，单文件撤销与整轮撤销均可用。
- 原本不存在的文件被创建后，撤销将其删除。
