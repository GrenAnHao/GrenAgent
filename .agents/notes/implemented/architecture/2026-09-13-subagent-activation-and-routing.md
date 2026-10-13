# Agent Note: 子代理：内嵌 Activation 可续聊，路由白名单现读、别名可直接用

Status: implemented

## Problem

94e5c5c5（2026-09-13）把 embedded spawn 改为可续聊的 Activation；需要 worktree 隔离的子代理由 agent-host 子进程 `spawn(process.execPath, [PI_WORKER_ENTRY])` 起 worker（`docs/architecture.md`）。DSH 子代理系列规格见 `docs/superpowers/specs/2026-09-13-dsh-subagent-*-design.md`。

分工理由（用户说明）：大概率是当时的技术债导致的。当前方向：默认进程内运行，worker 只用于崩溃隔离和进程级环境，worktree 由显式工具创建，见 [2026-10-11-subagent-redesign.md](../../implemented/architecture/2026-10-11-subagent-redesign.md)；「全部改为独立进程」已否决（[2026-10-11-all-subagents-out-of-process.md](../../rejected/architecture/2026-10-11-all-subagents-out-of-process.md)）。本笔记保留为当时的历史事实。

### 子代理自选路由：白名单每次现读，cheap / strong 别名可被发现并直接当 model 用

用户在设置里配了子代理便宜模型（cheap）和强模型（strong），并把白名单从 Opus 改成 Sonnet。一个 10-04 创建的长会话里，`list_subagent_models` 在设置保存 17 秒之后仍只返回 Opus。原因有两处：`readModelSelectionPolicy()` 在扩展 factory 里只读一次，白名单被冻结成会话创建时的快照；`list_subagent_models` 只列「白名单 ∩ 可用模型」，cheap / strong 按 2026-09-14 的设计不受白名单约束，但没有任何地方告诉模型它们存在，顶层 / `tasks[]` / `chain[]` 里写 `model: "cheap"` 还会报「不在授权白名单」。

### 单会话子代理上限只计仍占用的名额

单会话子代理上限按累计启动次数计算，一次性任务结束后名额不还。并行任务要等整段 `tasks` 写完才开工，完成态也要等整批工具返回。右坞加载运行中的子会话时，迟到的 `message_end` 会在工具后面再追加一份已经结束的思考和正文。

## Decision

### 子代理自选路由：白名单每次现读，cheap / strong 别名可被发现并直接当 model 用

`enabled` 仍在 factory 时定下（它决定 `spawn_agent` 有没有 `model` 字段，schema 之后改不了）。`allowlist` 改成每次访问都重读设置的 getter；自选开关被关掉时视为空集，撤销授权立即生效。`list_subagent_models` 在白名单行之后追加 cheap / strong 两行，写明解析到的路由和思考档，目标不在目录里时标「当前不可用」，解析不出的别名（策略为继承父模型、两个键都空）不列。`model` 字段在三处都接受 `cheap` / `strong`：`assertRouteAllowed` 对别名只要求能解析，不查白名单与目录；`pickSubagentModel` 把显式别名解析成路由；`thinking_level` 按解析后的模型校验。设置页两处文案同步。

### 单会话子代理上限只计仍占用的名额

名额在启动前预占，一次性任务结束或可继续会话收尾后释放。`tasks` 里已经闭合的任务在参数流还没写完时就启动，每个结束单独更新该行。横条用短任务名，模型写进工具结果，完成后仍显示。对得上最后一条已结束助手的 `message_end` 原地更新，不追加。

### 涉及文件

- `extensions/multi-agent/model-selection.ts`
- `extensions/multi-agent/list-models-tool.ts`
- `extensions/multi-agent/index.ts`
- `electron-agent/src/features/settings/settingsSchema.ts`
- `extensions/multi-agent/parallel-early.ts`
- `electron-agent/src/features/panels/subagentUtils.ts`
- `electron-agent/src/stores/agentReducer.ts`

### 来源

- `docs/decisions/extensions/2026-10-05-subagent-route-allowlist-live-aliases.md`
- `docs/decisions/extensions/2026-10-03-subagent-slot-and-parallel.md`
- 94e5c5c5
- 45c9450f（DSH 子代理 5–8 期计划）

## Alternatives considered

### 子代理自选路由：白名单每次现读，cheap / strong 别名可被发现并直接当 model 用

- 把 cheap / strong 自动并入白名单：设置页那一列还要区分「用户勾的」和「自动加的」，撤销别名要联动改白名单，还会让别名从「用户配好的默认」变成「模型授权的路由」，2026-09-14 §5.2 的区分就没了。
- 只让白名单现读、别名保持现状：解决了旧会话只看到 Opus，但用户配的 cheap / strong 对模型仍不可见，原来的困惑还会再来。
- 把策略快照写进父会话 JSONL 并在恢复时对比：2026-09-14 已否决，Pi 子级没有 `spawn_agent`，恢复旧会话时 schema 已按当前配置注册，快照与 schema 反而打架。
- 开关打开也做到立即生效：schema 里的 `model` / `thinking_level` 字段注册后改不了，勉强做要么每次 execute 隐式放行 schema 没声明的字段，要么重建工具，代价大于收益。仍为新会话生效。
- `list_subagent_models` 里先调 `modelRegistry.refresh()` 再读目录：这次的证据显示目录不是过期来源（`models.json` 的修改时间早于会话创建），也没读到 `refresh()` 的耗时和是否触发远端目录拉取，不为一个没证实的问题加一次磁盘或网络开销。

### 单会话子代理上限只计仍占用的名额

- 继续按累计次数封顶：做完的审查子代理会把后面的并行批次挡住。
- 等 `execute` 收到完整参数再一起启动：界面上要等所有任务文本都吐完才开始，结束也挤在同一次工具返回里。
- 用流式 JSON 解析器判断任务是否写完：它会自动补上未闭合的引号，半句任务会被提前开工。

## Consequences

### 子代理自选路由：白名单每次现读，cheap / strong 别名可被发现并直接当 model 用

白名单增删对已打开会话立即生效；开关开启仍要新会话。别名显式出现在 `model` 里时不再校验目录可用性，目标不可用只会在子代理启动时才报错，这与 `profile: {model: "cheap"}` 一致。

未处理的相邻问题：并行 `tasks[]` 在流式阶段提前启动（`launchEarly`，`index.ts`）时直接使用 `task.model`，没有走白名单校验，等 execute 校验失败时该任务可能已经在跑。需要单独设计「整批不启动」与「已提前启动的兄弟任务」怎么收场，不在这次改动里。

### 单会话子代理上限只计仍占用的名额

上限看的是当前占用，不是本会话一共启动过多少。可继续的子代理在还能被接着发消息时占着名额。参数流里 `profile` 还没写完时，并行任务会等这个字段闭合再启动。

## Verification

verify: n/a 回填的历史决定，源记录（docs/decisions）未记录验证
