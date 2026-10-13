# pi-multi-agent

为 [Pi coding agent](https://github.com/earendil-works/pi) 写的**子代理扩展**：`spawn_agent` 把任务委派给有独立上下文窗口的子会话，单任务、并行或链式都行。设计见 `.agents/notes/implemented/architecture/2026-10-11-subagent-redesign.md`。

## 能力

| 类型 | 名称 | 说明 |
|---|---|---|
| 工具 | `spawn_agent` | `action: "run"`（默认，前台等结果；等待时来了引导消息（steer，跟进不算），还没完成的转到后台、结束时各发通知，codemode 脚本里的调用和 chain 除外）或 `"spawn"`（后台跑，结果以 `subagent-settled` 通知送回）；`task` / `tasks`（并行）/ `chain`（链式）；`agent` 选命名角色；`fork` 继承父会话已完成的轮次 |
| 工具 | `wait_agent` | 等自己的任意一个后台子代理结算，只返回摘要，正文在随后到来的通知里 |
| 工具 | `send_message` / `interrupt_agent` | 和直接父 / 子代理互发消息（默认唤醒：空闲的开一轮，已卸载的冷恢复；`wake: false` 只投递不开轮，已卸载的直接追加到 JSONL）、打断后代当前这一轮 |
| 工具 | `list_agents` | 列出自己派过的直接子代理（来自父会话 JSONL 里的子代理目录，重启后照样有），状态只报 running / inactive |
| 工具 | `list_subagent_models` | 开启自选路由时列出可用的子代理模型 |

## 两个后端

子代理都是真会话（有 JSONL，能续聊、能 fork），只是跑的位置不同，代码见 `manager.ts` / `backends.ts`：

- **进程内**（默认）：在宿主进程里建子会话（`embedded-runner.ts`）。启动快、省内存。
- **worker**：每个子代理一个常驻 `pi-worker --mode subagent` 进程，宿主经 IPC RPC 驱动（`worker-session.ts` ↔ `worker-host.ts`）。死循环、内存耗尽、原生模块崩溃不连累宿主。只有设置 `SUBAGENT_BACKEND=worker` 或命名角色写了 `backend: worker` 才会用；同时运行的 worker 超过上限就排队。

## 审批

子会话没有自己的界面。需要人批准时（safety 判成 ask、bash 沙箱升权、mcp-policy 询问），请求经 `_shared/approval-route.ts` 一层层转给父会话，最后出现在顶层会话输入框上方的审批卡上，标明是哪个子代理，带倒计时。顶层会话在 `session_start` 时登记（`approval-top.ts`）；子会话在打开、冷恢复、装 Activation 时登记；worker 里的子会话经 RPC（`approval` / `approvalCancel`）交给宿主。走不到顶层（父会话没有界面、已经关掉，或设置为 0）时，主进程照旧把子代理的 ask 固定为拒绝。

worktree 不再由委派隐含：要隔离改动，调用方自己先调 `create_worktree`（`extensions/working-directory`），子代理继承调用方当前的工作目录。

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SUBAGENT_BACKEND` | `in-process` | `worker` 时子代理默认跑在独立 worker 进程里；命名角色的 `backend` 字段优先 |
| `SUBAGENT_MAX_WORKERS` | `2` | 同时运行的 worker 进程上限，超出的排队 |
| `SUBAGENT_MAX_ACTIVE` | `8` | 所有会话同时在跑的子代理上限，超出排队；嵌套的孙代理只计数不排队 |
| `SUBAGENT_MAX_RESIDENT` | `8` | 结算后仍驻留（续聊不必冷恢复）的进程内子会话数，超出按最久未用释放；`0` 关闭 |
| `SUBAGENT_APPROVAL_TIMEOUT_MS` | `60000` | 子代理需要人批准时，请求转到派它的会话的界面，最多等这么久（从发出请求算起），超时按拒绝；`0` 不转发，子代理的审批由主进程固定拒绝 |
| `SUBAGENT_MAX_PER_SESSION` | `6` | 单会话仍占用的子代理名额；`0` 不限 |
| `SUBAGENT_MAX_DEPTH` | `2` | 委派深度上限 |
| `SUBAGENT_TIMEOUT_MS` | `300000` | 空闲超时：连续无活动超过此值才判卡死（工具在跑、等模型时不计） |
| `SUBAGENT_STARTUP_MS` | `max(idle×2, 300000)` | 第一段输出之前的宽限 |
| `SUBAGENT_STREAM_STALL_MS` | `120000` | 上游卡住：模型开始推流后两次流事件之间安静超过此值，就本地中断这次请求并补一句「继续」 |
| `SUBAGENT_FIRST_TOKEN_MS` | 同 `SUBAGENT_TIMEOUT_MS` | 同上，用于请求发出后还没收到第一段输出 |
| `SUBAGENT_STALL_RETRIES` | `2` | 上游卡住时自动续跑的次数；用完按空闲超时结束 |
| `SUBAGENT_STUCK_MS` | `300000` | 注册表里后台子代理无活动超过此时长判为卡死 |

## 文件结构

```text
multi-agent/
├── index.ts            # spawn_agent（单任务 / 并行 / 链式 / 后台），名额与注册表
├── manager.ts          # 唯一入口：选后端、统一结果、后台交付
├── backends.ts         # 进程内 / worker 两个后端，同一套 runner
├── embedded-runner.ts  # 建子会话、超时看门狗、可续聊 Activation 启动
├── worker-session.ts   # worker 后端宿主侧：起进程、代理会话、排队
├── worker-host.ts      # worker 进程侧：托管一个子会话，RPC 方法
├── activation.ts       # 可续聊子代理的收件箱、结算、驻留池、冷恢复
├── active-runs.ts      # 同时活跃上限与在跑清单（agent-host 诊断采样也读它）
├── list-agents.ts      # list_agents
├── subagent-meta.ts    # 子会话 subagent_meta 的唯一读取处（冷恢复、重启回收）
├── child-runs.ts       # 后台运行中的子代理登记（wait_agent、父等子）
├── wait-agent.ts       # wait_agent
├── detach.ts          # 前台 run 等待时来了 steer：还没完成的子代理转到后台
├── teardown.ts         # 释放边界：每一步单独 try/catch，失败汇总成一行日志（漏网错误归属在 _shared/leak-owner.ts）
├── approval-top.ts     # 顶层会话登记审批路由的终点（路由本身在 _shared/approval-route.ts）
├── adjacent-tools.ts   # send_message / interrupt_agent
└── runner.ts           # 共用：结果类型、模型路由、派生运行时配置
```
