---
title: 沙箱拒绝作为事实返回，升权并进 bash 的同一次调用
status: active
date: 2026-10-05
scope: extensions
files:
  - extensions/_shared/sandbox/operations.ts
  - extensions/_shared/sandbox/facts.ts
  - extensions/_shared/sandbox/userBash.ts
  - extensions/_shared/sandbox/escalationGrant.ts
  - extensions/sandbox/bashTool.ts
  - extensions/sandbox/bashJob.ts
  - extensions/sandbox/escalation.ts
  - extensions/sandbox/index.ts
  - extensions/safety/index.ts
  - extensions/agent-mode/modes.ts
  - electron-agent/src/features/tools/bashCardModel.ts
  - electron-agent/src/features/tools/ToolExecution.tsx
supersedes:
superseded_by:
---

## 背景

沙箱拒绝、runner 失败、`SANDBOX_UNAVAILABLE` 原来由 `operations.ts` 当输出字节写进流里：它们进完整日志、后台任务输出环和 50KB 截断额度，后台任务被拒时结算通知只写 `exit code: 1`，界面认不出被拒。升权走单独的 `bash_escalate`，靠 `pendingDenial` 按命令文本配对，批准后直接调 `operations.exec` 重跑：不注册任务、不截断、超时不转后台、非零退出不标错。`docs/superpowers/specs/2026-09-12-os-sandbox-design.md` 把 `bash_escalate` 定为唯一的模型侧升权通道，这次推翻它。DSH（`packages/shell/tool-pwsh`、`packages/sandbox/sandbox/src/escalation.ts`）是执行器返回 `sandbox: { mode, denied, runnerFailed }`，工具层渲染标记，升权是同一个工具的 `sandbox_permissions` + `justification`。

## 决定

照 DSH 分层。`exec` 返回 `{ exitCode, sandbox }`，不往 `onData` 写任何标记。bash 前台把拒绝标记（可升权时加一行提示）接在输出和截断说明之后、`Command exited with code N` 之前，结构化事实放进 `details.sandbox`（只在被拒、沙箱没启动、已升权时有）；runner 失败返回 `isError`，不报退出码。后台和转后台的任务由 `processOutcome` 把说明并进结算 detail。`user_bash` 由 pi 显示输出，经 `withTextMarkers` 把事实写回原来的文字，只有拒绝行去掉了指向 `bash_escalate` 的半句。标记原文和解析放在纯模块 `facts.ts`，渲染层用 `parseSandboxNote` 认后台任务 detail，底栏显示中文说明。

升权：bash 加可选的 `sandbox_permissions`（`workspace-write` / `danger-full-access`）和 `justification`，执行前按 DSH `approveEscalation` 的顺序裁决：成对、理由非空、同模式不算升权、必须严格更宽、「工作区编辑」档拒绝、需要审批通道（有界面且是主会话回合）、用户批准。批准后这一次调用带 `PI_SANDBOX_MODE_ONCE` 走正常的 job 路径。理由只要求非空，去掉了至少 20 个字符的规则：中文一句完整的理由常常不到 20 个字，门槛是审批。sandboxGate 与 operations 的 `getPolicy()` 同源，都用会话 cwd，避免审批时看的模式和执行时不一致、批准下来的放宽被静默忽略。safety 的 `tool_call` 审批对同一次调用已经问过并允许时，留一张按会话 + toolCallId + 模式的一次性许可，bash 不再弹第二次；bash 在任何校验之前先消费这张许可，校验失败也不会把它留给之后同 id 的调用，已中止的调用不弹审批。safety 只把理由非空的升权当作升权，与 bash 的校验对齐，否则按普通询问处理、不留许可。删掉 `bash_escalate`、`pendingDenial`、`justifyOk`。

## 放弃的方案

- 保留 `bash_escalate`，只把它的执行改走 bash 同一条路径：两个工具、两套校验；「先被拒才能申请」靠命令文本配对，带最后一行的模糊匹配，命令稍有出入就失败。
- 只做事实结构化、升权维持现状：提示里还得指向 `bash_escalate`，批准后的重跑仍然不是 job。
- 把事实放进 `structuredContent`：pi 的包都不把它给模型（codemode 只在声明了 `outputSchema` 时交给脚本），模型只读正文，标记必须在正文里；bash 的 `outputSchema` 钉在 pi 1.0.2，加字段会破契约。
- 拆 stdout / stderr 成 `[stderr]` 段：pi 的输出约定是两路按时间顺序合一，分段后看不出报错在哪一步之后；DSH 分开是因为它的执行器本来就是两路。
- 后台任务卡底栏直接显示 detail：detail 里是写给模型的英文标记和升权提示，改成认出标记后显示中文，原文留在悬停提示里。
- safety 把升权写进 `ToolCallFacts` 发给主进程：`toolPermission/rpc.ts` 按白名单解析 facts，多的字段会被丢掉，升权参数本来就在 `rawArgs` 里进审计。
- 只看 `ctx.hasUI` 判断有没有审批通道：goal 回合它仍是 true，宿主却对所有对话框立即返回取消，模型会被提示去升权、又立刻被取消。

## 后果

bash 的参数变了、少了一个工具，系统提示前缀缓存重建一次。旧会话里的 `bash_escalate` 调用回放成普通工具卡。

模型可以不经拒绝就申请升权，门槛只剩用户审批和提示词约束。如果出现频繁预先申请，再考虑恢复「最近一次被拒」的校验，按 toolCallId 记，不按命令文本。

safety 按规则自动放行的调用没有许可，bash 照常弹升权提示；带升权的询问只给「允许本次 / 拒绝」：「总是允许」只会记命令规则，用户却会以为是对升权的长期授权。批准后执行时模式没变（审批期间切了审批档），`details.sandbox` 不记 `escalatedFrom`，界面不显示「已升权」。被后面的钩子拦下、没走到执行的调用留下的许可，会在会话关闭时清掉。

审批通道靠 `resolveToolOrigin() === "main"` 判断；宿主以后让 goal 回合也能弹审批，这里要跟着改。
