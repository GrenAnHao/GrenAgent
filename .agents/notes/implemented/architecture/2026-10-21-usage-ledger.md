# Agent Note: 用量统计改为写入时记账，报表查 SQLite 账本

Status: implemented

## Problem

打开「用量统计」要等四五秒。旧的 `UsageService.report()` 每次把 `~/.pi/agent/sessions` 下全部会话整份读进来逐行 `JSON.parse`，本机 931 份、814MB，单次 4～6s，跑在主进程。数据明明在每次模型调用结束时就产生了，却要等看报表时再从 jsonl 里反推，会话越攒越多，报表越来越慢。

反推还有口径问题：`truncateSessionTo`（回退 / 编辑消息）会截断会话文件，被截掉的轮次从统计里消失，但那些 token 已经花掉了；删掉的会话同理。

## Decision

来源登记、预热独立表和加法迁移的现行契约见 [请求观测与可信来源](./2026-11-10-request-observability-and-usage-origin.md)；本篇保留原 assistant 写入 / 汇总口径及其取舍。

### 写入：扩展在 `message_end` 记账

新增扩展 `extensions/usage-ledger/`。每条助手消息的 `message_end` 里，如果 `role` 是 `assistant` 且带 `usage`（与旧扫描同一口径），就往 `<agentDir>/usage/ledger.db` 写一行，同一个事务里 upsert 会话信息（id、`getSessionFile()`、cwd、会话头时间、`getSessionName()`）。记账失败只打一行 stderr，不影响对话。

- 注册：`extensions/index.ts` 三张清单，`cli/src/extension-profile.ts` 与 `multi-agent/embedded-runner.ts` 的 `CORE_ALWAYS_ON`。主会话、嵌入式子代理、子进程子代理、命令行 pi 都加载。
- 时间取记账那一刻的 ISO 时间，和 pi 随后写进 jsonl 的条目时间只差几毫秒；落盘预汇总按前 10 位分日（UTC），展示另按本地时间切分。
- 去重键 `callKey`：有 `responseId` 用 `r:<provider>:<responseId>`（全局唯一，分叉复制出来的同一条调用只记一次）；没有就 `t:<sessionId>:<message.timestamp>`；导入时两者都没有再退回条目 id。本机 46,896 条调用全部带 `message.timestamp`，412 条没有 `responseId`，没有重复的 responseId。

### 账本：SQLite，汇总表由触发器维护

`calls`（键为主键、`INSERT OR IGNORE`）、`sessions`、`meta` 三张表，外加 `rollup`：按 日 × 会话 × provider × 模型 汇总，由 `calls` 的 `AFTER INSERT` 触发器 upsert，和记账是同一条语句、同一个事务，别的进程写账也一样；被去重忽略的插入不触发。本地日报从原始时间戳按日、会话、渠道、模型分组后计算各维度，保证本地午夜在所有视图中一致。报表继续附最近 500 条调用作预览；明细超出预览时，独立查询按当前时间、项目、供应商和模型先计数，再取每页 20 条，不把全量调用明细发给渲染层。WAL 模式，`_shared/sqlite.js` 设了 5 秒 `busy_timeout`，多进程并发写靠它排队。

`sessions` 的 upsert 用 `COALESCE`：已知字段不会被 null 覆盖，`started_at` 保留第一次写入的值，名字以最新的非空值为准。

### 查询与历史导入：在 agent-host 子进程

`usage_report` / `usage_reconcile` 经 `createAgentPorts().usage` 转到 agent-host（`AGENT_METHODS` 加 `usage.report` / `usage.reconcile`），由 `electron/app/usageService.ts` 处理。同步 sqlite 和导入时的解析都不占主进程。

- `report()`：`meta.import_version` 不是当前版本时，先把会话目录导入一遍，再查账本；之后每次都是纯 SQL。
- `reconcile()`（界面上的「补录」）：扫一遍会话目录，`INSERT OR IGNORE` 补进账本没有的调用，返回补了几条。用于命令行 pi 之外没加载扩展的运行时，或记账上线之前的会话。并发调用共用一次扫描。
- 导入用 `sessionLineScan` 按 ASCII 标记 `"session_info"` / `"usage"` 找行，只解码命中的行；每个文件一个事务，4 个文件并发，文件之间回到事件循环。导入口径变了就加 `IMPORT_VERSION`，下次打开会重新补录（按键去重，不会重复计数）。

### 报表维度与筛选

时间和项目筛选在账本内执行，先筛再求和、截取明细；不能从最多 500 条明细反算全局。项目身份来自工作目录，不来自可变会话标题；应用管理的独立对话和无工作目录的记录共享「未归属会话 (全局对话)」。最近会话仍展示标题，兼容旧版保存的 JSON 标题。模型占比按标准请求模型跨渠道合并；原始供应商、请求模型与响应模型留在明细，不能把未证实的路由等价当作模型别名。

三张图的 Token 和调用数沿用助手口径；费用维度汇总助手与独立预热的已记录金额，包括供应商报告、目录估算和来源未知三类。页面显示费用来源，不把已记录总额当作供应商结算金额。环形图只折叠排名六名以后的模型；先汇总金额或 Token，再分配整数百分比，保证非空分布总和为 100%。

### 渲染层

`UsagePanel` 头部保留「补录」并就地显示结果。最近会话的名字优先取侧栏会话列表（`allSessions`，按路径匹配，之后改过名也对得上），账本里的名字兜底；侧栏列不出来的会话（已删除、子代理会话）不可点击，悬停说明原因。只在筛选条件一致时先画缓存；迟到的旧范围数据不能覆盖新的筛选结果。第一次打开的「加载中」写明会导入历史。

桌面会话表搜索、排序要覆盖所选项目和时间内的全部会话摘要，而不是先截取最新 50 个再排名。只在此表请求完整摘要，原查询保留 50 条上限；不读取正文。默认隐藏 Token 和费用均为零的行，点击可用会话复用侧栏的加载/切换流程。趋势及日期筛选按本机自然日查询原始调用和预热时间戳；只重标 UTC 汇总日期虽然便宜，但无法拆开同一 UTC 日内分属两个本地日的调用。保留写入时的 UTC 预汇总，不做历史迁移。环图用中心读数显示当前扇区，不再叠加第二层浮窗。

涉及文件：

- `extensions/usage-ledger/{ledger.ts,index.ts}` 及测试
- `extensions/index.ts`、`extensions/multi-agent/embedded-runner.ts`、`cli/src/extension-profile.ts`
- `electron-agent/electron/app/usageService.ts` 及测试
- `electron-agent/electron/agentProcess/{contract.ts,mainBindings.ts,runtimeGraph.ts}`、`mainBindings.test.ts`
- `electron-agent/electron/ipc/register.ts`、`electron-agent/electron/main.ts`
- `electron-agent/src/lib/pi.ts`、`electron-agent/src/features/usage/UsagePanel.tsx`、`src/features/devtools/IpcPlaygroundTab.tsx`

## Alternatives considered

- **保留扫描，按文件缓存 + 只读追加部分 + 落盘缓存** — 最强的理由：口径与 jsonl 完全一致，不需要新扩展和新库，当天实现并实测过（同进程再次打开约 0.12s、重启后约 0.2s，首次约 2.3s）。否掉：每次打开仍要枚举并 `stat` 全部会话文件、在 JS 里重新汇总几万条记录，耗时随会话数线性增长；回退 / 删除会话丢账的问题还在；还要为截断后续写设计尾部指纹。那一版没有提交，被本篇整体取代。
- **`fs.watch` 会话目录，只给变化的文件打标记** — 最强的理由：省掉每次打开时的全目录 `stat`。否掉：仍是从 jsonl 反推，丢账问题不变；Windows 上递归监听的可靠性和关机期间的变化都要另外兜底。
- **在 agent-host 的 `piRuntimeService.handlePiEvent` 里记账，不加扩展** — 最强的理由：所有 GrenAgent 主会话的事件本来就经过这里，不用碰扩展清单和 `CORE_ALWAYS_ON`。否掉：子进程子代理和命令行 pi 的事件不经过它；扩展是 pi 自己的生命周期钩子，任何加载了扩展包的运行时都覆盖得到。
- **报表直接对 `calls` 做 `GROUP BY`，不要汇总表** — 最强的理由：少一张表和一个触发器。否掉：本机 4.7 万行时每个聚合要 30～55ms，整份报表约 0.23s，还会随调用数线性增长；加了 `rollup` 之后约 5ms。
- **账本用追加写的 jsonl 文件** — 最强的理由：和会话格式一致，不需要 sqlite。否掉：要么报表时再全量读一遍（问题回到原点），要么自己维护汇总和去重；多进程并发追加也要自己处理。工程里 `node:sqlite` 已在用（子代理注册表就是多进程写同一个库）。
- **应用启动后在后台预先导入历史** — 最强的理由：第一次打开用量页也是瞬时的。否掉：导入只发生一次（约 3～5s，在 agent-host 里，主进程不卡），为它让每次启动都去碰会话目录不划算；首次打开的提示里写明要导入。

## Consequences

- **收益**：本机实测，旧实现每次 4～5.3s；账本首次打开（导入全部历史）约 4.2～5.3s、只发生一次，之后每次打开约 4～6ms，与会话总量无关。账本约 13MB。导入结果与旧扫描逐项相同：totals 各项、按日、按模型、按项目、最近 500 条调用的 token 合计都一致。回退截掉的轮次、删掉的会话，用量不再从统计里消失。
- **口径变化**：「会话数」现在是有调用记录的会话数（本机与旧口径同为 931）。分叉复制出来的同一条调用（同一个 responseId）只计一次，旧扫描会算两次（本机没有这种数据）。
- **代价**：多一个扩展、一份库文件和一组 agent-host 方法；改账本表结构要考虑已有的库（目前靠 `CREATE ... IF NOT EXISTS`，加列要像子代理注册表那样补 `ALTER`）。没有加载扩展的运行时（例如别的 pi 前端）不会自动入账，要点「补录」。会话名在账本里是记账时的快照，界面以侧栏为准。
- **顺手修的**：`cli/src/extension-profile.ts` 的 `CORE_ALWAYS_ON` 原来漏了 `image-limits`，Electron 主会话带插件白名单时不加载它，`cli/src/agent-data-plugins.test.ts` 一直是红的；这次补上，见 [引导大图缩放](../bug-fix/2026-10-20-steer-image-size-limit.md)。

## Verification

本地午夜切分、顶部浮层、项目滚动及全量调用分页的[封版实测](../../../evidence/2026-11-25-usage-final/REPORT.md)取代下列旧截图中的 UTC 时间段及侧向悬浮。

图表悬停、表格排序与历史跳转见[用量统计交互验收](../../../evidence/2026-11-25-usage-inspection/REPORT.md)，含明暗主题、390px 窄窗以及同项目和跨项目历史正文的 Electron 实测。

用量分析新口径的 [定向验收与截图](../../../evidence/2026-11-25-usage-analytics/REPORT.md) 记录了模型与项目归一、筛选后的费用对账、明暗图表和精确值展示；下列时间与基准测量属于早期账本实现。

结果：通过（单测、真实 SDK 实跑、真实数据对照）；没有在运行中的 Electron 应用里点开验证。证据在 `.agents/evidence/2026-10-21-usage-ledger/`。

- `cd extensions && npx vitest run usage-ledger`：8 条通过，日志 `vitest-usage-ledger.txt`。`ledger.test.ts` 覆盖取 usage、去重键优先级、两边谁先记都只计一次、会话字段不被 null 覆盖、各维度聚合（经 `rollup`）、空账本、事务回滚；`usage-ledger-live.real.test.ts` 用真实 `AgentSession` + faux 模型 + 持久化会话跑一轮工具调用加回复，账本记了 2 笔，会话路径与磁盘上的 jsonl 相同，从 jsonl 算出的键与账本里的键一致（一条带 responseId、一条按消息时间）。
- `cd electron-agent && npx vitest run electron/app/usageService.test.ts electron/agentProcess electron/ipc electron/app/piPackageService.test.ts`：101 条通过，日志 `vitest-electron.txt`。`usageService.test.ts` 覆盖首次导入的口径、工具结果里的 usage 字样不计入、非 session 文件跳过、只导入一次而补录能补上新增、已实时记账的调用导入时不重复、回退和删除后用量保留、并发补录共用一次扫描；`mainBindings.test.ts` 要求新方法都登记在 `AGENT_METHODS`。
- `cd cli && node --import tsx --test src/extension-profile.test.ts src/gren-runtime.test.ts`：12 条通过（`cli-extension-profile.txt`）；`npx vitest run ../cli/src/agent-data-plugins.test.ts --root ..`（在 electron-agent 下）主仓库那份通过，日志 `vitest-agent-data-plugins.txt` 里的 FAIL 都是 `.claude/worktrees/*` 下其他工作区的副本加载失败，与本改动无关。
- 真实数据：`bench.mjs`（esbuild 打包旧实现与新 `usageService.ts`、`ledger.ts`，账本写到临时目录，不碰真实 `~/.pi/agent/usage`），输出 `bench-real-sessions.txt`。
- 类型：`npx tsc -p tsconfig.node.json --noEmit` 中本次涉及的文件没有报错（其余 160 余条是已有错误）；临时 tsconfig 只含 `UsagePanel.tsx`，没有报错。`npx electron-vite build --outDir <临时目录>` 打包成功，结尾复制 `pi-job-guard.exe` 时因为正在运行的应用占用 `out/main` 报 EBUSY，是构建插件写死 `out/main` 的复制步骤，与本改动无关，`out/main` 下的文件没有被改动。
