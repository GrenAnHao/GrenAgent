---
title: 上游卡住时只中断这一次模型请求并自动续跑，不杀子代理
status: active
date: 2026-10-05
scope: extensions
files:
  - extensions/multi-agent/embedded-runner.ts
  - extensions/multi-agent/README.md
supersedes:
superseded_by:
---

## 背景

sa-6ec19c91 推了 1.3 万字思考后，上游连续 5 分钟没有任何流事件，被空闲超时整段杀掉，前面 7 分钟的工作作废。空闲超时管的是整段子代理有没有动静，分不清「模型卡在一次请求里」和「子代理真的卡死」，前者只要重发这一次请求就能接着跑。pi 自带的自动重试只处理报错（429、5xx、断流），请求挂着不动既不报错也不结束，触发不了重试。

## 决定

嵌入式一次性子代理加一个卡顿看门狗，只盯「等模型」这一段：从 `turn_start` 到 assistant 的 `message_end`，期间没有工具在跑。已经开始推流后两次事件之间安静超过 `SUBAGENT_STREAM_STALL_MS`（默认 120 秒），或请求发出后迟迟收不到第一段输出超过 `SUBAGENT_FIRST_TOKEN_MS`（默认等于空闲超时），就 `session.abort()` 掉这次请求。会话回到空闲后，若最后一条是被中断的 assistant，补一条用户消息「（自动续跑）……请从中断前的状态继续」再跑。被中断的半条回复 pi 在投影时会跳过，模型从最后一个有效状态重新生成。最多续 `SUBAGENT_STALL_RETRIES`（默认 2）次，还卡就以 `idle timeout: upstream sent nothing for Ns (after N automatic retries)` 结束，界面和 job 结算现有的超时识别直接认得。等模型期间空闲定时器让给看门狗，心跳照常刷新注册表，免得被 `reapStuck` 抢先收掉。

## 放弃的方案

- 把卡住伪装成可重试错误交给 pi 自带重试：请求的中止信号就是会话的 abort 信号，中止只会得到 `aborted`，扩展拿不到 fetch 层去注入错误。
- 在 provider 请求上设超时：pi-ai 的 `timeoutMs` 只管到响应头，流开始以后停住管不到；而且要改每个 provider 配置。
- 用 `agent_before_settle` 返回 `continue: true` 续跑：中止后的那次结算拿不到「是看门狗中止的」这个上下文，还要在子会话里加扩展；runner 本来就拥有子会话，直接再 prompt 一次更直接。
- 统一把空闲超时调大：真卡住时等得更久，最后照样整段杀掉。
- 续跑时不加用户消息，直接让模型重来：pi 没有公开的「从当前上下文再跑一轮」入口；补一句说明也让会话记录里看得出这里发生过中断。

## 后果

每次续跑会重发一次完整上下文，费一次输入 token，但比重跑整个子代理便宜得多。模型推流中途合法地停顿超过 120 秒（比如不推送思考过程、在输出中途长考的模型）会被误判成卡住，表现为多一次续跑；这种模型要调大 `SUBAGENT_STREAM_STALL_MS`。只覆盖嵌入式一次性子代理；可续跑子代理（Activation 管理）、进程子代理和主会话没有这层处理。
