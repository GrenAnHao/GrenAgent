# bash 沙箱事实与同调用升权

照 DSH（`packages/shell/pwsh-sandbox`、`packages/shell/tool-pwsh`、`packages/sandbox/sandbox/src/escalation.ts`）分层：沙箱层只交事实，bash 工具负责给模型渲染标记、给界面放结构化字段；升权并进 bash 自己的一次调用，删掉 `bash_escalate`。

## 现状

- 拒绝、runner 失败、`SANDBOX_UNAVAILABLE` 都由 `operations.ts` 经 `onData` 当成输出字节写进流里。它们进完整日志、后台任务输出环和 50KB 截断预算；后台任务的结算通知只写 `exit code: 1`；界面没有任何代码识别它们，被拒和普通命令失败看起来一样。
- `bash_escalate` 是另一个工具，靠 `pendingDenial` 按「工作区 + 会话 + 命令文本」配对（带最后一行的模糊匹配）。批准后它直接调 `operations.exec` 重跑：不注册任务、超时不转后台、输出不截断、非零退出不标错，界面上是普通工具卡。
- 模型只读工具结果的正文。pi 的所有包都不读 `structuredContent`，我们只有 `after-tool-feedback`、`loop-guard` 原样透传它。

## 沙箱层：只交事实

`SandboxedBashOperations.exec` 返回 `{ exitCode: number | null; sandbox: SandboxRunFacts }`，类型放在 `extensions/_shared/sandbox/types.ts`：

```ts
export interface SandboxRunFacts {
  /** 这次实际生效的模式（含 PI_SANDBOX_MODE_ONCE 单次放宽）。 */
  mode: FileSandboxMode;
  /** 沙箱拦下了文件操作（attributeRun 判为 denial）。 */
  denied: boolean;
  /** 命令没有执行：隔离起不来、runner 失败、壳 spawn 失败。 */
  runnerFailed?: true;
  /** runnerFailed 的原因，原样交给模型和界面。 */
  detail?: string;
}
```

现有分支到事实的对应：

| 分支 | 事实 |
| --- | --- |
| Windows、受限模式、壳是 Git Bash / WSL | `runnerFailed`，`detail` 为现有 `WINDOWS_BASH_UNAVAILABLE` 的说明 |
| `confine` 抛 `SandboxUnavailableError` | `runnerFailed`，`detail` 为错误消息加现有提示 |
| 壳 spawn 失败（受限或不受限） | `runnerFailed`，`detail` 为 spawn 错误码 |
| `attributeRun` 判为 `denial` | `denied: true` |
| `attributeRun` 判为 `runner-failure` | `runnerFailed` |
| 其余 | `denied: false` |

`exec` 不再往 `onData` 写任何 `[sandbox: …]` 文字，也不再调 `rememberPendingDenial`。判定逻辑（`attributeRun`、`confine`、Windows runner）不动。

`user_bash` 由 pi 自己显示输出，交给它的是一层适配器 `withTextMarkers(operations)`：按事实把和现在完全相同的文字写进 `onData`，行为不变。`bashJob.ts` 的 `ExecFn` 跟随新的返回类型。

## bash 工具：渲染

给模型的标记（原文）：

- 拒绝：`[sandbox: file access denied under <mode> mode]`
- 升权提示：`[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`
- runner 失败：`[sandbox: the sandbox runner failed under <mode> mode — the command did not run; this is a sandbox problem, not a command failure]`，下一行是 `detail`

升权提示只在这次调用确实能升权时出现，三条同时满足：当前模式还有更宽的模式（`read-only` 或 `workspace-write`）；预设不拒绝升权（沿用现有规则：「工作区编辑」档下的 `workspace-write` 拒绝）；`ctx.hasUI`（子代理和 goal 回合没有界面，拿不到审批，不提示）。

前台：

- 标记追加在输出文本之后，pi 的状态行 `Command exited with code N` 仍在最后（经 `appendStatus`）。
- runner 失败返回 `isError` 结果（正文为输出、runner 标记和 `detail`，`details.sandbox` 带事实），不再显示成 `Command terminated without an exit code`，不带 `structuredContent`。
- `details.sandbox` 只在被拒、runner 失败、已升权三种情况出现，形状为 `{ mode, denied, runnerFailed?, escalatedFrom? }`。普通成功的 `details` 仍是 `undefined`，pi 契约测试不变。

后台和转后台（`processOutcome`）：

- runner 失败：`{ status: "failed", detail: "<runner 标记> <detail>" }`。
- 被拒：`{ status: "completed", detail: "exit code: N; <拒绝标记>[ <升权提示>]" }`，照 DSH 把说明并进结算 detail。升权提示的条件在任务启动时算好，传给 `startBashJob`。
- 结算通知和 `job_output` 的状态行本来就带 detail，不用另改。转后台那一刻的结果（进程还在跑）不变。

## 升权：并进 bash

bash 在 `run_in_background` 之后加两个可选参数：

- `sandbox_permissions`：枚举 `workspace-write` / `danger-full-access`。描述：`The narrowest wider sandbox mode for a one-shot retry of the exact command the sandbox just denied; the retry asks the user for approval.`
- `justification`：字符串。描述：`Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access. Use the language of the user's current request.`

执行前按顺序检查，任一不过就返回 `isError`，命令不执行：

1. 两个参数必须成对出现，`justification` 去空白后非空。照 DSH 只要求非空，取代原来至少 20 个字符的 `justifyOk`：中文一句完整的理由常常不到 20 个字，审批才是门槛。
2. 申请的模式等于当前模式：不算升权，照常执行。
3. 必须严格更宽（`isStrictWidening`），否则：`sandbox escalation to "<mode>" is not strictly wider than this call's current "<mode>" mode`。
4. 预设规则（沿用）：「工作区编辑」档下的 `workspace-write` 拒绝升权。
5. 没有界面：`sandbox escalation to "<mode>" requires approval, but no approval channel is available`。
6. 审批：这次调用已经有 safety 留下的一次性许可（见下）就直接用，否则 `ctx.ui.select("沙箱升权\n\n<命令>\n\n<理由>\n\n→ <mode>", ["允许本次", "拒绝"])`。
   - 允许本次：这一次调用的环境带 `PI_SANDBOX_MODE_ONCE=<mode>`。
   - 拒绝：`the user rejected escalating this command to "<mode>"; it stays denied, so stop and explain instead of working around it`。
   - 取消：`approval for escalating to "<mode>" was cancelled`。
7. 走正常的 bash 路径：任务注册、流式、匿名前台 job、截断、超时转后台、`run_in_background` 全部照常。`details.sandbox.escalatedFrom` 记升权前的模式。

不再要求「先被拒才能申请」（DSH 的取舍），每次升权都要用户批准，提示词约束只在被拒后使用。

和 safety 审批去重：

- safety 的 `collectFacts` 在 bash 输入带 `sandbox_permissions` 时加上 `escalation: { mode, justification }`。裁决为「询问」时，safety 的提示里写明目标模式和理由；用户选「允许本次」或「总是允许」后，给这次 `toolCallId` 记一张一次性许可（新模块 `extensions/_shared/sandbox/escalationGrant.ts`，内存里，用一次即删，`session_shutdown` 时清空）。bash 消费自己 `toolCallId` 的许可，不再弹第二次。
- safety 按规则直接放行（没有问人）时没有许可，bash 照常弹升权提示：放宽模式总要有人批准。
- 「总是允许」只记 safety 的命令规则，不会让以后的升权变成静默。

删除和联动：

- 删 `bash_escalate` 工具、`pendingDenial.ts` 及其测试；`justifyOk` 没人用了就一起删。
- agent-mode 的 `ASK_TOOLS` 去掉 `bash_escalate`，注释同步。plan 模式不加规则：所有 bash 调用（带不带 `sandbox_permissions`）照旧过 `isSafeCommand`。ask 模式照旧允许升权，经审批。
- `BASH_PROMPT_GUIDELINES` 加一条：`Use bash with sandbox_permissions + justification only to retry the exact command the sandbox just denied, choosing the narrowest wider mode; the user approves every retry, and a rejection means stop and explain.`
- 工具 schema 变了，系统提示前缀缓存重建一次。

## 界面

- `bashCardModel.ts` 加 `bashSandboxFacts(result)`，读 `details.sandbox`。模式中文名：`read-only` 只读，`workspace-write` 工作区写入，`danger-full-access` 完全权限。
- 折叠行 meta：被拒 `沙箱拒绝 · <模式>`；已升权 `已升权 · <模式>`；runner 失败 `沙箱未启动`。优先级 runner 失败 > 被拒 > 已升权：升权后仍被拒（比如升到工作区写入后写到了工作区外）按被拒显示，模式是升权后的模式。行图标不变：被拒和 runner 失败是 ✗（`isError`），升权后成功是 ✓。
- 展开后终端底栏一行：被拒 `沙箱拦下了文件访问（<模式>模式）`；runner 失败 `沙箱没有启动，命令没有执行：<detail>`；已升权 `本次已获批准，以<模式>权限运行`。终端正文不变，仍是给模型的文本。
- 后台任务卡底栏：完成态的 detail 除了 `exit code: N` 还带了说明时也显示 detail。这个格式由 `processOutcome` 自己写，不是解析命令输出。
- 升权审批沿用现有的 select 弹层。旧会话里的 `bash_escalate` 调用回放为普通工具卡。

## 测试

- operations：每个分支返回对应事实，`onData` 里不再出现 `[sandbox`；`user_bash` 适配器写出的文字和改动前逐字一致。
- bashTool：标记的位置和原文；升权提示的三个条件；`details.sandbox` 只在三种情况出现、普通成功仍为 `undefined`；runner 失败的 `isError` 结果；升权参数校验（成对、空理由、同模式不算升权、不够宽、预设拒绝、无界面）；批准后 `exec` 收到 `PI_SANDBOX_MODE_ONCE`、任务可见可停、截断生效；拒绝和取消时 `exec` 不被调用；有 safety 许可时不弹第二次；后台升权；任务结算 detail。契约测试的参数清单改为 `command, timeout, run_in_background, sandbox_permissions, justification`。
- safety：升权事实进 facts；询问提示带目标模式和理由；允许时记许可，拒绝或自动放行时不记。
- agent-mode：白名单不含 `bash_escalate`；plan 下带 `sandbox_permissions` 的 bash 仍过 `isSafeCommand`。
- `extensions` 的 `prompt-metadata.test.ts` 通过。
- 渲染层：`bashCardModel` 的事实解析和文案；ui-harness `bash-job-card` 加「前台被拒」「已升权」「后台任务带沙箱说明」三种情况。

## 落地顺序

一次改完再提交：只拿掉流里的标记而工具还没渲染，模型会看不到拒绝；提示指向已删的工具也不行。顺序是沙箱层事实和 `user_bash` 适配器 → bash 渲染和任务结算 → 升权参数、许可、删除 → 界面 → 决策笔记和 `architecture.md`。

## 不做

- 不拆 stdout / stderr：模型文本保持 pi 的两路合一、按时间顺序。输出环已支持通道标记，以后界面要把 stderr 标红再说。
- 不改沙箱判定和 Windows runner。
- 界面不从终端正文里剥掉模型标记。
- 不做全局任务入口。
