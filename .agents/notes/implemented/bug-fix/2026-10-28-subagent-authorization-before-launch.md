# Agent Note: 子代理完整授权后才启动并行任务

Status: implemented

## Problem

`spawn_agent` 的 `message_update` 在并行任务参数流尚未结束时调用 `launchEarly`，没有经过 execute 的显式模型白名单校验。白名单只含 `a/b` 时，流中的 `tasks[].model: a/c` 已启动，随后 execute 虽拒绝请求也无法撤销已发出的模型请求。顶层 model、profile、禁用策略和委派深度也可能晚于任务参数到达。

## Decision

参数流只供界面展示，不产生子代理启动副作用。删除独立的提前启动路径，全部任务由 execute 校验完整参数后交给现有并行 worker 启动，保留并发、取消、转后台和名额释放行为。

用户确认本次先堵显式 model 绕过白名单；角色默认、继承父模型和用户配置的 cheap / strong 别名沿用既有规则，不把白名单改成最终模型的全局限制。

旧笔记审计：[路由与 Activation](../../implemented/architecture/2026-09-13-subagent-activation-and-routing.md) 的提前启动及已知绕过被本决策取代，其余路由决定保留；[前台转后台](../../implemented/feature/2026-10-12-foreground-run-detach.md) 的提前启动接入段随删除更新，其余生命周期不变；[全部进程外运行提案](../../rejected/architecture/2026-10-11-all-subagents-out-of-process.md) 只涉及后端选型，与本次授权顺序无关。

## Alternatives considered

- 在 launchEarly 补每项白名单检查：保留参数生成与任务执行重叠的延迟收益。但任务闭合时顶层 model/profile/action 等字段可能尚未到达，无法执行完整请求的统一授权，且需要同步维护两套校验和失败收场逻辑，因此不用。
- 等 execute 拒绝时取消提前任务：保留现有启动体验、改动集中。但取消发生前已经可能调用未授权模型并产生费用，无法满足启动前授权，因此不用。

## Consequences

- 未授权显式模型无论位于 tasks、顶层还是 inline profile，参数流与 execute 都不会启动任务。
- 一批任务混入未授权显式模型时整批不启动。
- 授权任务仍并行运行，取消与转后台的既有回归通过。

并行任务启动推迟到本次工具参数全部生成并通过校验之后；这段等待换取完整且唯一的授权边界。没有真实 Fable 调用参数，本次测试证明该漏洞可复现，不把它认定为用户现场的唯一原因。

## Verification

- `cd extensions; npx vitest run multi-agent/index.test.ts -t 'authorization before parallel launch'`：5 项回归在修复前全部失败，修复后全部通过；覆盖任务内显式模型、后到的顶层模型与 inline profile 模型、混合授权批次，以及授权后真实并发的启动边界。
- `cd extensions; npx vitest run multi-agent prompt-metadata.test.ts`：36 文件通过、1 文件跳过，517 项通过、2 项跳过。沿用 runner 边界替身，不请求真实模型；覆盖取消、转后台、名额释放及路由既有规则。
- `cd extensions; npx vitest run`：extensions 全量 243 文件通过、2 文件跳过，2270 项通过、27 项跳过。
- `npm run verify-notes`：通过；既有 6 篇笔记缺结果词的警告与本次改动无关。
