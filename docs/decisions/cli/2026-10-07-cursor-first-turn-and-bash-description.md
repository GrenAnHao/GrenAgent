---
title: Cursor 请求合并相邻用户消息；流内 bash 补 description
status: superseded
date: 2026-10-07
scope: cli
files:
  - cli/src/cursor/vendor/providers/cursor.ts
  - cli/src/cursor/exec-handlers.ts
  - cli/src/cursor/user-merge.test.ts
  - cli/src/cursor/exec-bridge.test.ts
supersedes:
superseded_by: cli/2026-10-07-remove-cursor-provider.md
---

> 已过时 → 见 [2026-10-07-remove-cursor-provider.md](2026-10-07-remove-cursor-provider.md)

## 背景
两个问题，都只在 Cursor 上出现。

第一个：新会话第一次发送，模型总是回应 CodeGraph 提示（「Understood. I'll use grep…」），第二次发送才真正执行请求。原因是扩展在回合开始前注入的上下文（渲染约定、行为说明、MCP 列表、CodeGraph 提示），pi 的 `convertToLlm` 会把每一段都变成单独的 `user` 消息，排在用户原话后面。Cursor 的请求只把最后一条 user 消息当作本轮动作，前面每一条都变成一个没有回复的历史回合，所以模型回答的是 CodeGraph 提示，用户原话留在历史里没人理。第二次能跑通，是因为模型看到同样的提示已经回应过，就往前找到了问题，这是碰巧，不是正确行为。

第二个：Cursor 发起的 bash 全部报 `Validation failed for tool "bash": description: must have required properties`。GrenAgent 的 bash 经 `withBashUiDescription` 包装后，`description` 是必填参数（工具卡片折叠时显示的摘要）。Cursor 的 shell 帧只有在 `ShellArgs.description` 有值时才带它，`pi_bash` 帧根本没有这个字段。

## 决定
- 在 vendor 的 `buildGrpcRequestForWireMode` 入口，把每一段连续的 user 消息合并成一条：文本按原顺序用空行连接，图片保留，assistant / toolResult 不动。本轮动作和历史回合都用合并后的消息。
- 桥的 `localCall("bash")` 总是带上 `description`：Cursor 给了就用它的，没给就按命令第一行的程序名生成「Run node」这样的摘要（带引号的路径整体识别）。工作目录只经工具上下文传递，不放进参数。vendor 为 shell 帧合成工具块时也带上 `ShellArgs.description`，卡片与实际执行的调用保持一致。

## 放弃的方案
- 合并时把用户原话挪到注入内容后面：需要假定一段连续消息里第一条才是用户原话，steering 等情况下不一定成立。实测按原顺序合并后，模型已经回答原话，不需要调整顺序。
- 把注入的上下文改成 system prompt：要改各扩展的注入方式，影响所有供应商，只为 Cursor 不值得。
- 只对 Cursor 会话去掉 CodeGraph 提示：其他几段注入同样会顶掉原话，治标不治本。
- 用命令原文当 description：bash 的提示词明确要求不要把原始命令放进 description，卡片标题里已经显示命令。
- 去掉 bash 的必填 description：会改所有供应商的 bash 定义和提示词。

## 后果
合并后，Cursor 看到的历史与会话文件里的消息条数不再一一对应，只在发请求时合并，会话文件不变。Cursor 没给 description 时，卡片摘要只有程序名，信息比模型自己写的少。以后 GrenAgent 的工具再加必填参数，Cursor 的帧映射同样会被校验拦下，要在 `localCall` 里补上。
