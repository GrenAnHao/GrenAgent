> 已迁移：本决定现由 [.agents/notes/implemented/architecture/2026-10-04-permission-channel-timeout-policy.md](../../../.agents/notes/implemented/architecture/2026-10-04-permission-channel-timeout-policy.md) 维护；本文件冻结只读。

---
title: 授权通道超时先重试一次，仍失败只拦这一次调用、不结束回合
status: active
date: 2026-10-04
scope: extensions
files:
  - extensions/_shared/desktop-control.ts
  - extensions/memory/client.ts
  - extensions/safety/index.ts
supersedes:
superseded_by:
---

## 背景

工具调用前 safety 通过本机 TCP 问主进程 `permission.tool.evaluate`，5 秒超时。sidecar 和主进程跑在同一个事件循环里：主线程被卡住几秒后，客户端计时器比响应先触发，请求被当成拒绝，返回「已被授权规则拒绝」并 `terminate`。一次并发启动八个子代理时，四个子代理和主会话在同一秒收到这条拒绝，`tool_audit` 里这段时间一条记录都没有，说明根本没有规则参与。`terminate` 让子代理停在 toolUse 上、没有正文，以 `(no output)` 出错退出。

## 决定

`MemoryClient` 的超时和连接中断带上 `ETIMEDOUT` / `ECONNRESET` 代码。`evaluateToolCall` 遇到连接层失败（超时、拒连、断开）立刻重试一次，再失败才返回 deny 并标 `unavailable`。主进程回的错误帧和不合法回包仍直接 deny，不重试。safety 看到 `unavailable` 时照样拦下这次调用，原因写「授权服务暂时没有响应，X 未执行」，但不带 `terminate`，模型可以重试或换路。

## 放弃的方案

- 通道失败时放行：没有规则判定也没有审计，等于无记录执行，和整条链路 fail-closed 的方向相反。
- 只把超时调长：卡顿超过新阈值时问题一样，而且每次卡顿都让工具多等这么久。
- 无限重试直到成功：主进程真的挂了时工具调用会一直挂着。

## 后果

通道抖动时多一次请求；第一次请求如果其实已在主进程处理，`tool_audit` 会多一行。`unavailable` 只覆盖连接层失败，主进程长时间无响应时模型会反复收到这条拦截，靠 loop-guard 兜底。主线程为什么会卡几秒是另一件事，见运行诊断日志。
