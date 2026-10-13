# Agent Note: 子代理的审批转给父会话的界面，限时等待

Status: implemented

## Problem

子会话没有自己的界面。2026-09-14 照 DSH 把子代理的审批固定为拒绝，规格见 `docs/superpowers/specs/2026-09-14-dsh-subagent-delegation-scope-design.md`：
- 主进程 `toolDecisionService.evaluate` 把「子代理 + ask」改判为 deny，规则是 `builtin.subagent-ask-pinned`。
- 子代理的系统提示写着「需要审批的操作会被自动拒绝」。

结果是父会话在 auto / ask 档时，子代理碰到要问人的操作（危险命令、工作区外写入、网络、MCP、代码执行）一律失败，用户就在旁边也没有机会批。另外两处也一样：
- bash 的沙箱升权在子代理里一律不可用（`approvalChannel` 只认主会话）。
- mcp-policy 的询问落在子代理的空界面上，回的是「用户拒绝执行」，这个说法会误导。

子代理重新设计时，用户确认了决定 10：无人值守时等待审批，60 秒超时，超时按被拒返回。见 [2026-10-11-subagent-redesign.md](../architecture/2026-10-11-subagent-redesign.md) 第 7 节。开工前又确认了四点：
- 推翻固定拒绝，默认打开，设 0 可以关回去。
- 计时从子代理发出请求算起。
- safety、bash 升权、mcp-policy 三处都转。
- 渲染层做队列、倒计时和 `dismiss`。

## Decision

子代理需要人批准时，请求一层层转给父会话，最后出现在顶层会话输入框上方的审批卡上，限时等待，超时按拒绝。

### 审批路由（`extensions/_shared/approval-route.ts`）

- 按会话文件路径登记（会话文件全局唯一），两种路由：
  - **顶层会话**：在 `extensions/multi-agent/approval-top.ts` 的 `session_start` 里登记。条件是有界面、不是子会话（JSONL 里没有 `subagent_meta`、ALS 不是 subagent）、不在 worker 进程里。路由的终点是它自己的 `ctx.ui.select`。`session_shutdown` 时注销。
  - **子会话**：在三处登记，路由只记父会话路径和自己的身份（agentId、任务首行）。
    - 新开子会话（`openEmbeddedChildSession`），会话结束时注销。
    - 冷恢复（`openResumedChildSession`）。
    - 装 Activation，和父会话宿主登记同进同出；驻留续聊也重新装 Activation，所以路由跟着它。
- 请求每经过一层子会话，就把那一层的身份加进 chain。到了顶层，标题前面写「子代理 A（sa-1） › B（sa-2）」，顶层的在前。
- **worker**：worker 进程里查不到父会话，就走 upstream，经 RPC 交给宿主再查。
  - 新增三个 RPC 方法：
    - `approval`：发出请求。
    - `approvalCancel`：撤回请求。
    - `approvalReachable`：问宿主那边父会话能不能问到人。父会话可能没有界面、已经关掉，或者宿主设置成了 0，所以 worker 不能一概当成能问。
  - worker 里的子代理被打断时撤回请求；发出之前就被打断的，不再弹卡。
  - worker 进程退出时，宿主撤回它所有在途的请求。
  - 宿主进程里能不能问到人是同步算出来的，派子代理不因此多等一拍；只有 worker 里派孙代理时才要问宿主。
- **等待时长**：`SUBAGENT_APPROVAL_TIMEOUT_MS`，默认 60000，从子代理发出请求算起，设置页有一项。设 0 不转发，回到固定拒绝。
  - 子代理被打断时撤回请求。
  - 界面不理会撤回信号时，到点也不再等它的回答。
- **结果**：分四种。
  - 答复了：允许或拒绝。
  - 超时。
  - 取消：卡片被关掉，或子代理被打断。
  - 没有路由：判定之后父会话没了。

### 三处问人都走路由（只对子代理）

- **safety**：
  - 子代理能走到顶层时，工具调用事实带 `approvalRoute: true`。
  - 主进程判成 ask 后，经路由问人，选项和主会话一样（允许本次 / 总是允许 / 拒绝）。
  - 各种结果的处理：

    | 结果 | 审计回填 | 子代理收到 |
    |---|---|---|
    | 超时 | `timeout` | 「N 秒内没有人批准 X，视为被拒」（不 terminate，带子代理的换路提示） |
    | 取消 | `aborted` | 「授权请求已取消」 |
    | 没有路由 | `aborted` | 委派范围的拒绝文案 |
- **bash 沙箱升权**：`approvalChannel` 改为「主会话有界面，或子代理有路由」，询问经路由发出。
- **mcp-policy**：子代理只有在有路由时才算「有界面」，否则按 headless 拦下。询问经路由发出，结果分开回：
  - 超时：「N 秒内没有人批准，视为被拒」。
  - 取消：「授权请求已取消」。
  - 没有路由：headless 的拦截文案。

### 主进程

- **判定**：`toolDecisionService` 只在 `approvalRoute` 不为真时，把子代理的 ask 固定为拒绝。有路由的照常返回 ask，审计记为 `queued`，不写 `queuePayload`，所以不进待处理队列；sidecar 问完人再回填结果。
- **RPC**：`rpc.ts` 只认字面量 `true`。
- **审计**：`AuditResolution` 新增 `timeout`，扩展和主进程两份类型都改了。审计表的这一列是 TEXT，不用迁移。

### 委派声明

派出子代理时，看父会话能不能替它问人，选一版声明写进子代理的系统提示：
- **能问人**：「需要审批的操作会转给用户批准，最多等 N 秒；被拒绝或超时就不要重试，在回复中说明限制」。
- **不能**：保持原来的「会被自动拒绝」。

### 界面

- **`SessionUiAdapter`**：
  - 把 `subagents` 原样转给渲染层。
  - 请求结束（答复、超时、撤回、整体取消）时发一条 `dismiss`。这是新增的方法，只带原请求 id，不改已有字段。
- **`uiPromptStore`**：从「每个工作区一格，新的覆盖旧的」改成队列。一次显示一条，其余排在 `waiting` 里；第一条答完或被宿主收回，下一条顶上来。
- **`PromptRequestCard`**：
  - 子代理的请求，卡头写「子代理请求批准」。
  - 带 timeout 的请求按收到的时刻倒计时，剩 10 秒以内变成警示色。
  - 有排队时写「还有 N 条」。
  - 换卡后 400 ms 内不认点击：下一条顶到同一个位置、按钮也在同一处，双击或上一条到点前一刻的点击会落在新卡上（可能是「总是允许」）。第一次出现的卡不受影响。
- **`OverlayUiPromptCard`**：显示中的是主会话的确认 / 输入 / 普通选择时，写出后面还排着几条，免得子代理的审批在后面悄悄超时。
- **后台会话的暂存请求**：
  - 那个会话这一轮结束时照旧丢掉，但子代理的请求例外，因为它有自己的超时，宿主会发 `dismiss`。
  - 会话进程退出时宿主已经不在，不会再发 `dismiss`，子代理的请求也一起丢掉。
  - `dismiss` 把请求从画面、队列、后台暂存里都摘掉。

## Alternatives considered

- **保持固定拒绝**（DSH 现状，见 DSH 仓库的 `.agents/notes/archived/feature/2026-08-10-subagent-approval-pinned-never.md`）。
  - 最强理由：子代理永远不会卡在审批上。DSH 的理由是阻塞的子代理在界面上看不出来，而转给父会话还要先有父链归属和发起调用的 id。
  - 没选：用户确认了决定 10。Pi 这边的条件不一样：
    - 审批卡按会话路径落在父会话上，并标明是哪个子代理。
    - 等待有上限，到点按拒绝。
    - 子会话的父会话路径本来就记在 `subagent_meta` 和 Activation 里。
  - 设成 0 就回到固定拒绝。
- **计时从卡片显示出来算起。**
  - 最强理由：每条请求都给人完整的 60 秒。
  - 没选（用户选的是从请求算）：排队时后面的子代理要等好几个 60 秒，没人在时一批并行请求要几分钟才全部结束。
- **只转 safety。**
  - 最强理由：改动最小。
  - 没选：bash 升权和 mcp-policy 同样是「要人批准」。只转一处，子代理在另外两处仍然悄悄失败，mcp-policy 还会说「用户拒绝」。
- **不动渲染层，只在宿主侧让子代理的请求一个一个发。**
  - 最强理由：不改界面，不用新场景。
  - 没选：渲染层一个工作区只有一格。主会话自己的请求会把子代理的卡盖掉，被盖掉的会悄悄超时；宿主超时后卡片还留着，点了也没人收。
- **把子会话的整个 uiContext 换成转发到父会话的界面。**
  - 最强理由：三处问人的代码都不用改。
  - 没选：子代理里别的扩展也会调 `select`（例如让模型出选择题的 ask helper），它们也会弹到用户面前，超出了「审批」的范围。

## Consequences

- **收益**：
  - 父会话在 auto / ask 档时，子代理也能做需要批准的操作，只要有人在时限内批。
  - 审批卡写明是哪个子代理（孙代理带上父链）、要做什么、还剩几秒。
  - mcp-policy 不再把「没人能问」说成「用户拒绝」。
- **代价**：没人在时，每个需要批准的操作要等满时限才失败（原来是立即失败）。
  - 并行的子代理同时请求，计时各自从请求算，所以所有请求都在一个时限内结束。
  - 「总是允许」写的是工作区规则，对主会话也生效，和主会话的审批卡一样。
- **看不到的情况**：
  - 父会话不是当前显示的会话时，请求暂存在那个会话下，切过去才看得到；没切过去就会超时按拒绝，侧栏上没有别的提示。
  - 显示中的是主会话的确认 / 输入时，子代理的审批排在后面，照样倒计时；卡片只写出「还有 N 条待处理」。
- **goal 回合**：父会话正在跑 goal 回合时，宿主会立即取消所有对话框，子代理很快收到「授权请求已取消」。
- **dismiss**：
  - 只有宿主活着时才会发。agent-host 崩溃后，画面上和队列里残留的卡要点一下（或关掉）才会消失；后台暂存的会在退出时丢掉。
  - 答复过的卡在别的窗口里也会被收掉，这是 `dismiss` 每次都发带来的副作用，目前是期望行为。
- **CLI**：交互模式（TUI）的顶层会话按同一逻辑登记，子代理的审批会走 TUI 的选择框，这一点没有实跑。print 模式没有界面，照旧固定拒绝。
- **取代**：2026-09-14 规格里的「子级审批钉死为拒绝」现在只在走不到界面时成立（父会话没有界面、已经关掉，或设置为 0）。DSH 的委派声明和拒绝文案保留，用于这些情况。
- **实跑脚本的限制**：临时 HOME 里没有 Windows 沙箱 helper，所以实跑用 `write` 代替 `bash` 当标记操作。
  - 用自定义 `--outDir` 构建时，`copyPiAdjacentAssets` 仍只拷到 `out/main`，自定义目录里没有 `pi-sandbox-win.exe`。
  - 只影响这类测试构建，不影响应用。

## 验证

仓库里没有 `verify-*` skill。证据在 `.agents/evidence/2026-10-12-subagent-approvals-via-parent/`，说明见该目录的 `README.md`。结果：通过。

- 实跑 `.agents/evidence/2026-10-12-subagent-approvals-via-parent/real-run.mjs`（真实 agent-host 加 `custom-muqywnc8/claude-haiku-5-5`，超时临时调成 8 秒）：25 项全部通过（审查后的修正重新构建后复跑）。日志：`.agents/evidence/2026-10-12-subagent-approvals-via-parent/real-run.txt`。
  - **进程内子代理，答「允许本次」**：
    - 审批卡落在父会话上，标题写出子代理 id 和要写的文件，带 `timeout: 8000` 和 `subagents`，选项和主会话一样。
    - 授权判定收到 `approvalRoute: true` 并判成 ask，审计回填 `user_allow`。
    - 文件真的写了出来；答复后宿主发了 `dismiss`。
  - **进程内子代理，没人答**：约 8 秒（8009 ms）后宿主发 `dismiss`，审计回填 `timeout`，子代理收到「8 秒内没有人批准 write，视为被拒」，文件没写。
  - **worker 子代理**：子会话 meta 是 `backend: worker`，审批卡同样落在父会话上，worker 里的 safety 也带 `approvalRoute: true`，批准后文件写出来。
  - **设置为 0**：没有审批卡，授权判定不带 `approvalRoute`，固定拒绝，子代理收到委派范围的拒绝。
- `cd electron-agent && npm run ui:check -- subagent-approval`：32 项全部通过。日志：`.agents/evidence/2026-10-12-subagent-approvals-via-parent/ui-check-subagent-approval.txt`，截图在同目录的 `shots/`。
  - 覆盖：子代理卡头和标题（孙代理带父链）、倒计时在走、两条子代理请求加一条主会话请求排队（「还有 2 条」）、双击「允许本次」只答第一条、第二条顶上来、`dismiss` 显示中的那条后主会话的顶上来（没有倒计时）、`dismiss` 排队中的那条不影响显示中的、剩 10 秒内变警示色、浅色主题。
  - `--changed --dry-run` 列出 12 个场景受波及，原因是 `uiPromptStore` / `backgroundUiRequests` / `lib/pi.ts` 被它们间接引用。没有跑：那些场景不发交互请求，`PromptRequestCard` 在它们里面什么都不渲染；`lib/pi.ts` 只加了类型字段。
- `cd extensions && npx vitest run _shared/approval-route _shared/delegation-scope safety mcp-policy sandbox/bashTool multi-agent`：635 个通过 / 2 个跳过。日志：`.agents/evidence/2026-10-12-subagent-approvals-via-parent/vitest-extensions-targeted.txt`。
  - 新增：`_shared/approval-route.test.ts`、`multi-agent/approval-top.test.ts`。
  - 补测试：safety、mcp-policy、bash 升权、activation、embedded-runner、worker-session（RPC 转发与撤回）、manager（委派声明两版）、delegation-scope。
- `cd electron-agent && npx vitest run electron/app/toolPermission electron/agent/sessionUiAdapter src/stores src/features/chat src/features/extensionUi`：1281 个通过。日志：`.agents/evidence/2026-10-12-subagent-approvals-via-parent/vitest-electron-renderer-targeted.txt`。
  - 新增：`uiPromptStore.test.ts`。
  - 补测试：主进程判定与 RPC、adapter 的 `dismiss`、暂存、审批卡、`ExtensionUiHost`。
  - 两个依赖「新请求覆盖旧请求」的旧用例按队列语义改写。
- `cd extensions && npx vitest run`（全量）：1907 个通过，1 个失败，是已知的 `deleteSemantics`。日志：`.agents/evidence/2026-10-12-subagent-approvals-via-parent/vitest-extensions-full.txt`。审查前那一轮里 `resource-manager/mcp-store` 的文件监听时序失败过一次，单独连跑 3 次都通过。
- `cd cli && node --import tsx --test src/gren-runtime.test.ts src/extension-profile.test.ts src/pi-worker.test.ts`：16/16 通过。日志：`.agents/evidence/2026-10-12-subagent-approvals-via-parent/cli-tests.txt`。
- `cd electron-agent && npx vitest run electron`：17 个失败。记录：`.agents/evidence/2026-10-12-subagent-approvals-via-parent/electron-main.txt`。
  - 其中 15 个是 HEAD 上就失败的同一批（6 个文件）。
  - 另外 `gitService`、`tencentdbRemoval` 是满负载下的已知超时，单独复跑全部通过。
- `cd electron-agent && npx tsc -p tsconfig.node.json --noEmit`：154 条，和子代理重新设计第 4 阶段逐条一致。记录：`.agents/evidence/2026-10-12-subagent-approvals-via-parent/tsc-compare.txt`。
- agent-host 冒烟（入口用 `out/subagent-approval`）：15 项全部通过。日志：`.agents/evidence/2026-10-12-subagent-approvals-via-parent/agent-host-smoke.txt`。
- 代码审查（只读的子代理审查）找出 1 个 HIGH、6 个 MEDIUM / LOW，都已改正并补了测试，上面的数字是改正后的：
  - HIGH：换卡时双击会答掉顶上来的那条。
  - worker 一概当成能问人。
  - 审批卡被主会话的提问挡住时看不出来。
  - mcp-policy 把取消说成用户拒绝。
  - 发出前就撤回的请求照样弹卡。
  - 界面不理撤回信号时会一直等。
  - 宿主退出后子代理的暂存卡还会被放回。
- 未实跑：CLI 交互模式下子代理的审批，以及 bash 升权经路由的真实执行（临时 HOME 没有沙箱 helper；单元测试覆盖了升权经路由批准后带着放宽的模式执行）。
