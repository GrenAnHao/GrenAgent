# Agent Note: 子进程日志转发隔离同步断管错误

Status: implemented

## Problem

用户截图的 Electron 主进程异常为 `EPIPE: broken pipe, write`，堆栈是 `SyncWriteStream._write → console.error → AgentProcessClient.log → pipeLines`。失败的是主进程写控制台日志，不是 agent-host 的 RPC 管道。`pipeLines` 的 data/end 回调没有隔离日志输出的同步异常；启动器或终端不再接收输出时，一条诊断日志就会中断回调并触发主进程异常对话框。

已有 `browser/brokenPipe.ts` 提供 EPIPE 判定和全局处理器，但主进程入口没有安装该处理器。现有客户端测试始终注入不会出错的日志回调，未覆盖默认 console 输出。

历史检索：`2026-10-16-agentdata-host-process` 的 EPIPE 是失效 RPC 连接，机制不同，不修改；`2026-10-12-subagent-leaked-errors-and-teardown` 规定子代理漏网错误归属，保持不变。没有找到同主题日志断管笔记。

## Decision

在 `AgentProcessClient.log` 同步调用边界复用 `isBrokenPipeError`，仅忽略 EPIPE，覆盖默认 console 和注入的 log 回调。其他错误原样重抛。错误尾巴仍在转发日志前收集，断管不影响后续行、RPC、退出状态和尾巴。

## Alternatives considered

- 安装现成全局 `installBrokenPipeGuards`：最强理由是能覆盖整个主进程的同步与流 error。但它吞掉来源不明的 EPIPE，并接管所有 uncaughtException；而且异常到全局时原 data 回调已中断，同一 chunk 剩余日志不会继续。本次在已证实的日志输出边界处理，不改变全局故障策略。
- 对日志吞掉所有异常：最强理由是诊断输出不应影响业务。但这会隐藏自定义 logger 的程序错误与权限问题；只接受截图证明的 EPIPE。

## Consequences

默认 console 与注入 logger 同步抛出 EPIPE 时，stdout/stderr 的 data 和 end 路径继续完成，同一 chunk 后续行仍处理，RPC 继续，退出时 stderrTail 完整。非 EPIPE 仍原对象抛出。

断管期间控制台日志无法显示，这是日志接收方不可用的直接结果。此修复只隔离客户端同步日志调用，不宣称覆盖其他 console 调用或异步 Writable error；不重连终端，不改业务管道。

工作区同名旧生成 JS 遮蔽测试源码的问题单独记录在[待修复笔记](../../proposed/bug-fix/2026-11-10-generated-js-shadows-ts-tests.md)。本次只同步 `agentProcessClient.js` 的同一处修复，避免本机普通构建继续取旧实现；它仍是未跟踪生成物，持久源码为 `.ts`。其他既有生成文件保持不动。

## 验证

证据目录：`.agents/evidence/2026-11-10-agent-host-log-broken-pipe/`。结果：通过以下定向检查；没有运行全仓测试、完整应用重启或 UI 场景。

- 源码红绿：在 electron-agent 下运行 `npx vitest run --config ../.agents/evidence/2026-11-10-agent-host-log-broken-pipe/vitest-source.config.mts electron/agentProcess/agentProcessClient.test.ts electron/browser/brokenPipe.test.ts`。临时配置明确加载 TS，修复前 4 failed / 27 passed（`vitest-source-red.txt`），修复后 31 passed（`vitest-source-final.txt`）。覆盖默认 console / 自定义 logger、两条流、多行/后续 chunk/end、RPC、stderrTail、非 EPIPE 原对象重抛。
- 同步本机目标生成 JS 后，常规 `npx vitest run electron/agentProcess electron/browser/brokenPipe.test.ts`：6 文件、63 项通过（`vitest-normal-green.txt`）；显式源码配置的同范围也 63 项通过（`vitest-source-green.txt`）。没有扩大到不相关测试。
- `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe --import tsx ../.agents/evidence/2026-11-10-agent-host-log-broken-pipe/smoke.mts`：Electron 38.8.6 / Node 22.22.0，真实客户端拉起真实子进程，真实 stdio 与 IPC；只在 console 接收方同步注入 EPIPE，6 条日志均尝试、RPC 为 pong、退出 code 0、stderrTail 完整（`electron-smoke.txt`）。这不是终端实际断连或完整 GUI 复现。
- 当前可用技能没有匹配此主进程故障的 verify-* 技能，使用上述真实运行时探针。没有关闭用户当前应用或拉起第二份 GUI。
- `npm run verify-notes` 的结果见证据目录 `verify-notes.txt`。
