# Agent Note: Repo Wiki 与知识卡的模型轮次预算按用途分层，剩余额度直接报给模型

Status: implemented
Archived: 2026-11-13

## Problem

Repo Wiki 与知识卡在真实模型上反复卡在同一处：**stage 把轮次用完，却没有产出可用的 JSON**，整次生成失败。

`note-pocock-flow`（zh，真实模型）三次取证：

| 场景 | 现象 |
| --- | --- |
| Repo Wiki catalogue | `650dc081` 两次尝试都失败，第二次是合法 JSON 但为单对象 |
| Repo Wiki 全量 | catalogue 收齐 49 个 section、41 个子节点就位后，一个 child 失败即整次终止 |
| 知识卡 | `card:modules/notes` 恰好用满 20 轮（等于 `maxModelRequests`），第 20 轮返回 9,597 token 的正文，仍判 `INVALID_MODEL_JSON` |

三处症状不同，但共享同一个前提：**所有阶段共用 `maxSteps: 10` / `maxModelRequests: 20`，而模型并不知道这个数字**。它把上限当成"可以继续读"的许可，一路读到最后一轮，最后一轮既要探索又要作答。

更关键的是取证困难：为了搞清"为什么跑满"，需要用真实模型重跑六轮，每轮 4–8 分钟。`knowledge_build_items` 只记终态，不记每轮形状，`payload` 在解析失败时是 `null`，没有任何线索。

## Decision

**一、轮次预算按用途分层，不从全局继承。**

`wikiService/referenceProfiles.ts` 的 `maxStepsByPurpose`：overview / plan 10，catalogue 4，page 3，incremental 3–6。`knowledgeKernel/executionPolicy.ts` 的 `DEFAULT_KNOWLEDGE_EXECUTION_POLICY.profiles`：`page` 24，`module-card` 28，`repository-card` 24。依据是该阶段**已经拿到了什么**：page 的提示词已提供仓库树、README 和依赖文件，不需要 10 步探索。

真正生效的是冻结在任务元数据里的 `executionPolicy`，`DEFAULT_KNOWLEDGE_BUDGETS` 只是未冻结时的回落值。改默认值而不改 policy 不生效——这一点在实施中踩过一次。

**二、剩余额度必须写进对话，而不只是写进系统提示。**

系统提示里的"请把需要的读取合并到一轮"是**愿望**，模型不执行。改成每轮工具返回后追加一条状态：剩余多少读取、分布在多少轮里、这一轮建议要几个。

效果（同一项目、同样内容）：平均每轮工具数 1.00 → 1.97，请求数 198 → 115。

**三、收尾提示用命令式，并提前一轮。**

`FINAL_TURN_WARNING = 3`：剩 2 轮时明确"这是最后一轮带工具，下一次回复必须是完整 JSON"；剩 1 轮时清空 `tools` 并要求作答。旧措辞"还有 N-1 轮工具调用"被模型理解成还能继续读。

**四、每个 stage 记录轮次形状。**

`StageExecutionResult.diagnostics` 记录每轮的 `outputTokens` 与 `toolCalls`，解析失败时另存被拒原文（截断 32 KiB）。落 `knowledge_build_items.diagnostics` 列，`store.readDiagnostics()` 可读。

这条让"56% 的轮次只发起一次读取"（185 次工具轮次中 101 次输出 < 300 token）一眼可见，不必重跑真实模型。

**五、provider 超时可重试。**

供应商 120 秒 `Request aborted` 原被判为永久失败，一个已读完大半资料的 stage 就此丢失。`aborted` 与 timeout 类错误现在标 `retriable: true`。

## Alternatives considered

- **只调大上限不改提示** — 最省事。否决：实测每张卡片都会跑到上限附近（23–28 轮），调大只是把撞墙位置往后推，token 成本线性上涨而成功率不变。
- **缩短 `maxSteps` 到极小值** — 能强制模型早点作答。否决：overview 和 plan 确实需要探索源码，一刀切会让这两类阶段直接失败。按用途分层才是正确的切法。
- **在 `toolExecution` 层做限制** — 看起来更刚性。否决：`sequential` 只约束同一轮内的执行顺序，无法阻止模型一轮只请求一个工具；限制并发反而让它更慢。
- **让 stage 在证据足够后主动收口（按已读文件数判定）** — 更接近根因。暂缓：判定"足够"需要按阶段类型分别定义，改的是收口策略而不只是预算，风险面明显更大。本轮先把"额度可见 + 命令式收尾"做到位。
- **保留旧行为、只在失败时提示用户重试** — 零改动。否决：真实运行里这是**确定性失败**，不是偶发，重试同样会失败。

## Consequences

- **收益**：知识卡从 0/10 发布变为 10/10 发布，`state=completed`，14 项全部 prepared，0 失败；Repo Wiki 从 catalogue 失败变为 20/20 发布。两者都验证了页面正文与磁盘文件逐字相等。
- **收益**：`diagnostics` 让"跑满预算"这类判断从"需要六轮真实复现"降为"读一次数据库"。
- **代价**：单 stage 的请求上限提高（page 20→24、module-card 20→28），最坏情况 token 消耗相应上升。真实运行里知识卡 141 次请求、约 155 万 token，高于修复前的 17 次——因为修复前根本没写出来。
- **代价与已知上限**：批量读取的改善来自模型配合，不是强约束。若某次模型坚持一轮一个读取，仍会较快耗尽读取额度。**当 `diagnostics.turns` 里连续多轮 `toolCalls === 1` 且 `outputTokens < 300` 时，应重访这条决定**，考虑改成主动收口。
- **必须重访的信号**：`MAX_CATALOGUE_DEPTH`、`maxToolCalls` 或 `maxModelRequests` 三者任一被调整时，`maxStepsByPurpose` 的分层比例需要重新核对。

## Verification

- `npx vitest run --project main electron/knowledgeProcess electron/agentData/knowledgeKernel --maxWorkers=2 --testTimeout=60000`：28 文件 244 项通过。新增用例覆盖：轮次耗尽后仍发出且只发出一次纠正请求、剩余额度确实到达模型、`aborted` 判为可重试、`diagnostics` 含每轮形状与被拒原文。
- `npx vitest run --project main electron/wikiService`：15 文件 83 项通过，含 `maxStepsByPurpose` 的"page 往返少于 overview"用例。
- 真实运行证据：`.agents/evidence/2026-11-04-repo-wiki-real-run/REPORT.md`（Repo Wiki，20/20 发布）、`cards-fixed.md`（知识卡，10/10 发布）、`cards-hardening.md`（六轮失败的过程记录）。
- `npx tsc -p tsconfig.json` 与 `npx tsc -p tsconfig.repo-wiki.json --noEmit` 均为 0。
