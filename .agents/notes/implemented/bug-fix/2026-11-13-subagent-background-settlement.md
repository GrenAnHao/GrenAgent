# Agent Note: 子代理回复完成后按归属命令收尾

Status: implemented

相邻分工：[启动观察与生命周期修复](2026-11-17-visual-review-and-goal-lifecycle.md)只解释启动、首响应前和状态未确认，不因缺注册行推断终态。本篇后台 Bash 等待、超时、资源停止确认与真实结算仍独立有效，未被吸收。

## Problem

子代理 sa-d85ab86a 在 17:37:29 正常写出最终回复。此前转入后台的 bash-2504 尚未退出；17:42:30 通用无活动回收把子代理中止，父通知为 aborted，注册表为 error，现场扫描进程仍在。会话事件的时间戳不能代表后台命令的进展。

## Decision

保持 Activation 对 inbox、job 和孙代理的收尾屏障。正常结束本轮后，按归属 Bash 的可观测进展裁决等待超时；只停止超时实例。发出停止请求、命令确认退出和回复完成分别记录，三处结算消费者读取同一结果。兼容旧历史。

Windows 复用已随应用分发的沙箱 helper。进程内可续聊子代理的全权限 Git Bash 在独立的 Job Object 中启动；受限执行使用账户 runner 已有的 Job Object，不叠加一层而改变既有 UI 限制。停止请求经专用管道，只有该 job 中的进程全部退出才回执。回执通道不交给实际命令；旧的进程退出通知不能替代树退出确认。

## Existing notes audit

- [子代理重新设计](../../implemented/architecture/2026-10-11-subagent-redesign.md)：沿用 Activation 所有权、孙代理与 wait_agent 结算规则。
- [子代理通信与结算卡片](../../implemented/feature/2026-10-28-subagent-message-rendering.md)：沿用紧凑卡片和旧 aborted 语义；新结构化结果不再靠诊断文本猜测。
- [每次 Bash 都是 job](../../implemented/architecture/2026-09-12-own-bash-every-call-is-job.md)：沿用 job 身份及前台自动转后台。
- [子代理漏网错误与释放](../../implemented/feature/2026-10-12-subagent-leaked-errors-and-teardown.md)：保留错误与释放的边界；超时清理不借用通用取消。
- 前台转后台、不唤醒通信、Ultra 路由笔记不改变，本次不重新选择这些策略。

## Alternatives considered

- 最终回复一结束就结算：可立刻交付，但命令可能仍在写文件，破坏父代理依赖的收尾屏障。
- 延长通用超时或刷新会话心跳：改动小，但没有解决谁在卡住的问题，并发命令的输出还会掩盖卡死的同级命令。
- 改通知文案：能解释原始 aborted，但命令仍可能残留，列表和等待工具仍会收到不同结果。

## Consequences

- 等待期间仍可读取最终回复。整体超时原因由列表、父通知和 wait_agent 共用，旧记录不回填。
- 静默的正常任务无法提供进展证据；阈值只用于回复结束后的等待。10 秒未收到真实退出确认时，保留命令身份与观察路径，状态写「停止未确认」，不把整个子代理判成回复中止。

## Verification

证据：`.agents/evidence/2026-11-13-subagent-background-settlement/README.md`。旧逻辑复现失败，定向 Vitest、真实 Windows Git Bash 子进程清理和两个 Electron UI 场景通过。
