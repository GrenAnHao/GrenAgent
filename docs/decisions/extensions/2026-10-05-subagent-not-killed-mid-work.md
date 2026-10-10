---
title: 工具在跑时子代理不算空闲；codemode 脚本调子代理时去掉脚本时限
status: active
date: 2026-10-05
scope: extensions
files:
  - extensions/multi-agent/embedded-runner.ts
  - extensions/multi-agent/codemode-deadline.ts
  - extensions/multi-agent/index.ts
supersedes:
superseded_by:
---

## 背景

近三周 electron-mall-manager 里被中途掐断的子代理，32 个是旧版「空闲」定时器只在开跑时设一次造成的 5 分钟硬杀，已由 `2026-10-04-embedded-subagent-idle-timeout.md` 修掉。新版本上线后还有两类正在干活的子代理被杀。一类是父代理把 `spawn_agent` 放进 codemode 脚本，并写了 `// @options: {"timeout_ms": 480000 / 900000}`：脚本到点时 sandbox 中止所有在途的嵌套调用，三个子代理分别跑到 479、898、899 秒时被取消，`timeout_ms` 是父模型自己加的（codemode 工具说明里的示例就带着它）。另一类是子代理跑 `cargo build *> log`（`timeout: 1800`），命令整段没有输出，没有任何会话事件，6 分钟后被父侧 `reapStuck` 当卡死回收。上一篇笔记的「后果」里记过这一点：工具安静执行超过 `idleMs` 会被判空闲超时。

## 决定

嵌入式子代理记下在跑的工具（`tool_execution_start` 到 `tool_execution_end`，按 toolCallId，含嵌套调用）。有工具在跑时空闲定时器到点只顺延，不 abort；工具结束后从结束那一刻重新计空闲。硬上限 `SUBAGENT_MAX_MS`（默认 idle×10）照旧。有工具在跑时每 60 秒补发一次 `onUpdate`，注册表的 `updatedAt` 跟着刷新，`reapStuck`（阈值 300 秒）不再误收。

multi-agent 扩展挂 `tool_call`：codemode 脚本里出现 `spawn_agent`，且首行 options 带 `timeout_ms` 时，就地把 `timeout_ms` 从输入里去掉，其他 options 保留。只改执行用的输入，会话里记的调用不变。子代理自带空闲和硬超时，脚本不会因此无限挂住。

顺带：并行 early-start 路径被父回合中止时，注册表记 `cancelled`，和其余路径一致，不再记成 `error`。

## 放弃的方案

- 只在 `spawn_agent` 的提示里写「codemode 里别设 timeout_ms」：模型会照 codemode 工具说明里的示例写时限，提示管不住；还要多占系统提示。
- 脚本时限到点时把子代理转成后台 job 继续跑：脚本已经结束，没人收结果；而且嵌套调用拿到的中止信号分不清是脚本超时还是用户点了停止，误转会让用户停不下来。
- 把 `timeout_ms` 抬高到子代理硬上限而不是去掉：串行多步的脚本仍会在某一步被截断，数值也没有合适的下限。
- 工具在跑时完全不设上限：挂死的前台命令（比如误跑在前台的 dev server）会一直占着名额；保留硬上限兜底。
- 心跳直接写注册表 `touch()`：嵌入式 runner 不持有注册表，走已有的 `onUpdate → registry.progress` 不用新增依赖。

## 后果

被 `timeout_ms` 约束的 codemode 脚本，只要调了 `spawn_agent` 就不再有脚本级时限，最坏要等子代理自己的硬上限（默认 50 分钟）。工具挂死时子代理最多跑到硬上限才被收。进程子代理（`runner.ts`，CLI 用）没有改，安静工具仍按空闲判定。模型流本身超过 `idleMs` 没有任何增量时仍会被判空闲超时；如果常用长思考模型，调大 `SUBAGENT_TIMEOUT_MS`。
