---
title: Cursor 连接中断在模型出字前重试，闲置连接复用前先 ping
status: superseded
date: 2026-10-07
scope: cli
files:
  - cli/src/cursor/h2-pool.ts
  - cli/src/cursor/vendor/providers/cursor.ts
  - cli/src/cursor/transport-retry.test.ts
supersedes:
superseded_by: cli/2026-10-07-remove-cursor-provider.md
---

> 已过时 → 见 [2026-10-07-remove-cursor-provider.md](2026-10-07-remove-cursor-provider.md)

## 背景
刚启动的桌面应用第一次向 Cursor 发消息，22 秒后报 `read ECONNRESET`，0 token。omp 日志里只有一行「provider proxy resolved」，之后没有重试记录。同一时间、同一台机器上，用同一套令牌、同一份会话历史在 Node 和 electron.exe 里直接发请求都成功，所以出问题的只是那一条连接：它卡住了，Windows 在约 21 秒重传超时后报 ECONNRESET。网络走 Clash TUN（DNS 解析到 198.18.x 的 fake-ip）。

看代码有三处让一次连接抖动直接毁掉整轮：vendor 的 `isProviderRetryableError` 不认 `ECONNRESET`；`sawProgressOrSideEffect` 把 KV 取 blob 和 requestContext 握手也算作「模型已产出」，历史稍长时服务端一开始就会取 blob，重试闸门因此总是关着；死连接要等操作系统放弃才会报错，Windows 约 21 秒，其他平台更久。

## 决定
- 按错误码识别连接层故障：ECONNRESET、EPIPE、ETIMEDOUT、HTTP/2 会话/流错误，以及我们自己的 PING 超时，`cause` 链上的也算。replay 安全时，这类故障最多重试 2 次；每次先销毁原会话，保证重试走新连接。
- 心跳、KV 帧、requestContextArgs 不再计入 `sawProgressOrSideEffect` / `progressVersion`。三者都发生在模型产出之前，本地不执行任何东西，重试时服务端会重新要。
- 等待服务端时，连续 8 秒没收到字节就发一次 HTTP/2 PING，8 秒内没有 PONG 视为连接已死，按连接层故障结束本次尝试。PING 在传输层由对端直接应答，与模型或本地工具耗时无关。
- 连接池里的会话闲置满 20 秒，复用前先 ping，3 秒没有回应就销毁、重新连接。
- 重试用尽仍失败时，错误写成「Cursor 连接中断（原因），已尝试 N 次」，不再只显示 `read ECONNRESET`。

## 放弃的方案
- 把 ECONNRESET 加进 vendor 共用的 `isProviderRetryableError`：那份判断 omp 的其他供应商也在用，范围太大；改在 Cursor 的重试分支里判断就够了。
- 连接层故障沿用 5 次重试：每次都要等新连接建立，必要时还要等 PING 超时，最坏情况要等一分多钟才报错。2 次能覆盖一次性的抖动。
- 连接空闲就主动关掉，每轮都重新建连：放弃了 HTTP/2 复用，每轮多一次 TLS 握手，与设计文档「按源站复用」的目标冲突。
- 开 TCP keepalive：Windows 的 keepalive 默认间隔是小时级，改间隔要动 socket 选项，效果也不如 PING 直接。
- 模型已经开始出字后仍重试：重放会让同一段输出或工具调用出现两次，replay 安全闸门保持不变。

## 后果
模型开始出字之后连接断开，仍然会报错，只是文案更清楚；本地已经执行过的工具结果，由 agent-loop v2 补丁保留下来。PING 看门狗理论上会误判极慢但仍然活着的链路（8 秒内 PING 都回不来），那种链路本来也用不了。`CURSOR_MAX_TRANSPORT_RETRIES` 和几个阈值是按 Clash TUN 的表现定的；如果以后频繁出现「已尝试 3 次」，要先查网络路径，再考虑调大这些值。
