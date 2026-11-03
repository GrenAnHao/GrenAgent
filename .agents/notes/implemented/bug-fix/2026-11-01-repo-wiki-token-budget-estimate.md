# Agent Note: 知识内核 token 预算按 token 估算，缓存命中按一成计

Status: implemented

## Problem

`note-pocock-flow` 在「项目概览」阶段报 `BUDGET_EXHAUSTED`。任务 `7d4d98d1…` 只用了 3 次模型请求、9 次工具调用，远低于 12 次和 40 次的上限，真正超的是 token：

| 轮 | 预留 | 实际 input / output / 计数 |
|---|---|---|
| 1 | 38817 | 11875 / 255 / 12642 |
| 2 | 65382 | 7086 / 144 / 19518 |
| 3 | 87840 | 7864 / 155 / 27347 |

1. `runtimeBridge` 把 transcript 的 UTF-8 字节数直接当成输入 token 预留。JSON 结构与中文让字节数比真实 token 大好几倍；第 4 轮时已用约 6 万、预留又超过 10 万，加起来超过单项 12 万上限。
2. 工具循环每轮都重发整段上下文，大部分是 provider 缓存命中，但 `totalTokens` 把缓存读取按全价累计。即使估算正确，一个读十来个文件的页面也会在第 5～6 轮耗尽 12 万。

## Decision

- 预留输入按 `ceil(字节数 / 3) + 1024` 估算（`TRANSCRIPT_BYTES_PER_TOKEN`），仍是偏保守的上界。
- 计入预算的 token 用 `knowledgeBudgetTokens()`：input + output + cacheWrite + cacheRead/10，与常见计价一致；实时请求和重启后的用量对账使用同一公式。
- 默认上限：单项 `maxTotalTokens` 12 万 → 30 万，整任务 200 万 → 500 万。模型轮数、工具次数、读取字节等其他上限不变。已经卡在 blocked 的旧任务保留原预算，「重新分析」会建新任务并使用新默认值。

### 第二次受阻：模型轮数用完

修完 token 后重新分析（任务 `b3655536…`）又在「项目概览」受阻：token 只用了约 10 万（上限 30 万），但 12 次模型请求全部用完。模型每轮只读 2 个文件、从不收尾，第 13 次请求被拒。模型看不到单项预算，没人告诉它该停。

- `stageRuntime` 在系统提示里写明本阶段最多几轮、几次工具调用，要求一轮批量请求多个工具并留一轮给最终 JSON。
- 用 Agent 的 `prepareNextTurnWithContext`：剩余 3 轮起每轮追加剩余预算提醒；最后一轮（或工具次数用完）去掉工具并要求立即用已有证据返回完整 JSON、说明缺口。
- 默认单项 `maxModelRequests` 12 → 20、`maxToolCalls` 40 → 60，其余不变。

## Alternatives considered

- 只调大轮数上限：最省事；不采用，模型不知道预算时调多大都会读到最后一轮再被拒，仍拿不到结果。
- 只调大上限、不改估算：改动最小；不采用，按字节预留会把上下文窗口也一起占满（大页面直接超出 contextWindow），调多大都会提前失败。
- 预算完全不计缓存读取：最贴近 DeepSeek 计价；不采用，有的 provider 缓存读取并不便宜，按一成计保留了约束。

## 验证

- `pnpm exec vitest run electron/knowledgeProcess electron/agentData/knowledgeKernel electron/agentData/taskViewStore.test.ts src/features/repoWiki`：26 文件 192 项通过；新增两项断言（缓存折算公式、12 轮增长上下文不超单项预算），以及「30 KB transcript 在 16k 窗口内不再报 BUDGET_EXHAUSTED」。
- `pnpm exec vitest run electron/app/repoWikiKnowledgeKernel.integration.test.ts electron/app/repoWikiService.test.ts electron/app/repoWikiTasks.test.ts`：3 文件 28 项通过。
- 第二次修复后：`pnpm exec vitest run electron/agentData/knowledgeKernel electron/knowledgeProcess`：21 文件 127 项通过，新增「模型不停读文件时，最后一轮去掉工具并拿到最终 JSON」。`crashFixture` 与 store 测试改为按默认上限计算，不再写死 40/12。
- 日志在 `.agents/evidence/2026-11-01-repo-wiki-token-budget-estimate/`，`blocked-task-usage.txt` 是第一次受阻任务的逐次用量。未用真实模型重跑。

## Consequences

单次生成可能消耗的 token 上限变高：一个页面最多约 30 万计费 token，整任务最多 500 万。若要更严格的花费上限，调 `DEFAULT_KNOWLEDGE_BUDGETS`，不要回退到按字节估算。
