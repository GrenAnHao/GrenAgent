> 已迁移：本决定现由 [.agents/notes/implemented/architecture/2026-09-13-subagent-activation-and-routing.md](../../../.agents/notes/implemented/architecture/2026-09-13-subagent-activation-and-routing.md) 维护；本文件冻结只读。

---
title: 子代理自选路由：白名单每次现读，cheap / strong 别名可被发现并直接当 model 用
status: active
date: 2026-10-05
scope: extensions/multi-agent
files:
  - extensions/multi-agent/model-selection.ts
  - extensions/multi-agent/list-models-tool.ts
  - extensions/multi-agent/index.ts
  - electron-agent/src/features/settings/settingsSchema.ts
supersedes:
superseded_by:
---

## 背景

用户在设置里配了子代理便宜模型（cheap）和强模型（strong），并把白名单从 Opus 改成 Sonnet。一个 10-04 创建的长会话里，`list_subagent_models` 在设置保存 17 秒之后仍只返回 Opus。原因有两处：`readModelSelectionPolicy()` 在扩展 factory 里只读一次，白名单被冻结成会话创建时的快照；`list_subagent_models` 只列「白名单 ∩ 可用模型」，cheap / strong 按 2026-09-14 的设计不受白名单约束，但没有任何地方告诉模型它们存在，顶层 / `tasks[]` / `chain[]` 里写 `model: "cheap"` 还会报「不在授权白名单」。

## 决定

`enabled` 仍在 factory 时定下（它决定 `spawn_agent` 有没有 `model` 字段，schema 之后改不了）。`allowlist` 改成每次访问都重读设置的 getter；自选开关被关掉时视为空集，撤销授权立即生效。`list_subagent_models` 在白名单行之后追加 cheap / strong 两行，写明解析到的路由和思考档，目标不在目录里时标「当前不可用」，解析不出的别名（策略为继承父模型、两个键都空）不列。`model` 字段在三处都接受 `cheap` / `strong`：`assertRouteAllowed` 对别名只要求能解析，不查白名单与目录；`pickSubagentModel` 把显式别名解析成路由；`thinking_level` 按解析后的模型校验。设置页两处文案同步。

## 放弃的方案

- 把 cheap / strong 自动并入白名单：设置页那一列还要区分「用户勾的」和「自动加的」，撤销别名要联动改白名单，还会让别名从「用户配好的默认」变成「模型授权的路由」，2026-09-14 §5.2 的区分就没了。
- 只让白名单现读、别名保持现状：解决了旧会话只看到 Opus，但用户配的 cheap / strong 对模型仍不可见，原来的困惑还会再来。
- 把策略快照写进父会话 JSONL 并在恢复时对比：2026-09-14 已否决，Pi 子级没有 `spawn_agent`，恢复旧会话时 schema 已按当前配置注册，快照与 schema 反而打架。
- 开关打开也做到立即生效：schema 里的 `model` / `thinking_level` 字段注册后改不了，勉强做要么每次 execute 隐式放行 schema 没声明的字段，要么重建工具，代价大于收益。仍为新会话生效。
- `list_subagent_models` 里先调 `modelRegistry.refresh()` 再读目录：这次的证据显示目录不是过期来源（`models.json` 的修改时间早于会话创建），也没读到 `refresh()` 的耗时和是否触发远端目录拉取，不为一个没证实的问题加一次磁盘或网络开销。

## 后果

白名单增删对已打开会话立即生效；开关开启仍要新会话。别名显式出现在 `model` 里时不再校验目录可用性，目标不可用只会在子代理启动时才报错，这与 `profile: {model: "cheap"}` 一致。

未处理的相邻问题：并行 `tasks[]` 在流式阶段提前启动（`launchEarly`，`index.ts`）时直接使用 `task.model`，没有走白名单校验，等 execute 校验失败时该任务可能已经在跑。需要单独设计「整批不启动」与「已提前启动的兄弟任务」怎么收场，不在这次改动里。
