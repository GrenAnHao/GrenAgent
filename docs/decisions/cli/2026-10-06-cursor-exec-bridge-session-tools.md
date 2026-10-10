---
title: Cursor 流内工具改用会话工具链执行，中止时也写入已执行的结果
status: superseded
date: 2026-10-06
scope: cli
files:
  - cli/src/cursor/exec-handlers.ts
  - cli/src/gren-runtime.ts
  - cli/src/cursor/vendor/providers/cursor.ts
  - cli/scripts/patch-pi-cursor-loop.mjs
  - electron-agent/src/stores/agentReducer.ts
supersedes:
superseded_by: cli/2026-10-07-remove-cursor-provider.md
---

> 已过时 → 见 [2026-10-07-remove-cursor-provider.md](2026-10-07-remove-cursor-provider.md)

## 背景
一次真实的 Cursor 会话里，第一轮助手消息带了 21 个工具调用，会话文件里一条 toolResult 都没有，stopReason 是 aborted。下一轮模型说「上一轮写文件没成功」，又从头再做了一遍。查下来有六处问题：

1. 补丁把缓冲的结果放在 agent-loop 的 aborted/error 提前返回之后才写入，回合一停，已经执行过的结果全部丢失。
2. 桥不发 `tool_execution_*` 事件。界面上 Cursor 执行的卡片一直转圈，看不到输出；toolResult 的 `message_end` 又被 reducer 忽略。
3. 桥直接调用 `tool.execute`，绕过了 `beforeToolCall`，授权规则、计划模式、只读子代理都管不到 Cursor 发起的 bash/write；传给工具的 ctx 也只有 `{cwd, sessionManager}`，没有 `hasUI` / `ui`。
4. vendor 沿用 omp 的 read 写法，把 `:raw` / `:raw:70+20` 拼在路径后面，pi 的 read 不认识；文件不存在时也不回 Cursor 认得的 `Path '…' not found`。Cursor 自己的 edit 先读后写，读出错，新建文件就失败。
5. 会话里没有 `grep` / `ls` / `find` 工具（GrenAgent 用 `search`），这些帧都返回「Tool not available」。
6. 没有 `mcp` handler。Cursor 调用会话自定义工具（search、read_files、codemode 等）时，被告知「tool not found」；同一批调用等这轮流结束后，又由 agent-loop 在本地执行一次。

## 决定
`createCursorExecHandlers` 每次调用都走 pi agent-loop 的同一套步骤：`prepareArguments`、按 schema 校验（pi-ai 的 `validateToolArguments`）、会话的 `beforeToolCall`、用会话的扩展上下文（`extensionRunner.createToolContext`）执行、`afterToolCall`。执行前后经 `Agent.processEvents` 发 `tool_execution_start/update/end`，扩展、会话持久化和桌面界面都收得到。用的中止信号是本轮 run 的。shell 帧的 `workingDirectory` 只覆盖 ctx 的 `cwd`，其余 getter 保持惰性。

帧到工具的映射集中在 `localCall`：read 帧的 `:raw` 选择器还原成 `offset/limit`，负 offset 按行数换算；grep 帧在会话有 `grep` 时用 `grep`，否则用 `search`；会话没有 `ls` / `find` 时由桥只读地直接列目录、按 glob 找文件；MCP 帧按工具名调用会话工具。vendor 合成工具块时经 `BlockState.describeExecCall` 调用同一个映射，卡片的名字和参数与真正执行的调用、与 toolResult 一致。vendor 还在 Cursor 自己 edit 的读、写帧上加了 `materialize`：读直接返回文件原样字节，不截断、不加行号，文件不存在时回 not found；写走 write 工具和全部钩子，只发结束事件，卡片仍是流里那张 edit。grep 结果的转换补上了 `search` 的 `details.matches` 和 pi grep 的 `path:line: text` 两种格式，否则 Cursor 收到的永远是零匹配。

agent-loop 补丁升到 v2：在助手消息落定之后、提前返回之前写入缓冲结果；回合中止或出错时，已标记执行却没有结果的调用，各补一条「The run stopped before this call returned a result.」。v1 补过的文件原地升级，脚本也会直接补 electron-agent 自己那份 pi-agent-core 和 sdk.js，不再靠 pnpm 硬链接碰巧同步。reducer 收到 toolResult 的 `message_end` 时，把仍在运行、或被中止标成「已中断」的卡片换成真实结果，已经由 `tool_execution_end` 定格的不动。

## 放弃的方案
- 直接用 pi-agent-core 的 `runToolCall`：它调用 `execute` 时不传 ctx，没办法按 `workingDirectory` 换 cwd；cli 的 package.json 也没有把 pi-agent-core 列为直接依赖。
- 给会话补注册 `grep` / `ls` / `find` 工具，让名字对上：所有供应商的模型都会多出这几个工具，提示词和缓存前缀都会变。
- 执行时回头改写流里已经推出去的工具块：toolcall_end 与 tool_execution_start 到达界面的先后不固定，名字会被改回去。
- 在 agent.js 补丁里加一个公开的 emit 方法，代替调用私有的 `processEvents`：补丁要多维护一处升级逻辑；`processEvents` 正是 agent-loop 自己发事件的入口，行为一致。
- 中止时继续丢弃未配对的调用，交给 pi 重建上下文时剔除：执行过的副作用（写了的文件、跑过的命令）会从记录里消失，模型下一轮会重做，这次的会话就是这样。
- `mcpApprovalPreflight` 按授权策略回答：钩子没有只查询、不执行的入口。现在回 true，真正执行时仍要经过 `beforeToolCall`，该问用户的照问，该拒的照拒。

## 后果
依赖 pi 的两个非公开入口：`Agent.processEvents`（私有方法）和 `AgentSession.extensionRunner.createToolContext`，升级 pi 时要先确认两者还在，不在时桥退回 `{cwd, sessionManager}` 且不发事件。桥直接回答的 ls / find 不经过 `tool_call` 钩子，两者都只读。delete 帧仍回「Tool not available」；没有实现 shellStream，Cursor 要等命令结束才拿到输出，界面靠 `tool_execution_update` 实时显示。结果仍在整轮 Cursor 流结束后才写进会话文件。改了 vendor 的地方都标了 `GrenAgent:`，以后从 omp 同步时要逐处保留。
