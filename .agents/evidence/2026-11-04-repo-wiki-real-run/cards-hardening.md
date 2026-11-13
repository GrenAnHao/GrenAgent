# 知识卡 JSON 与预算加固：实施与真实运行记录

日期：2026-11-04
变更：`harden-knowledge-card-json`

## 已完成的代码改动

| 位置 | 改动 |
| --- | --- |
| `electron/knowledgeProcess/stageRuntime.ts` | `parseStageJson` 候选顺序改为「首 `{` 到末 `}` → 整段 → 仅末尾围栏（且需含 stage 键）」；新增 `source-parent` 语义；解析失败且答案 ≥256 字节时标 `retriable: true`；轮次耗尽后仍允许**一次**纠正请求且不计入轮次；`FINAL_TURN_WARNING` 文案改为命令式 |
| `shared/knowledgeKernelContracts.ts` | `DEFAULT_KNOWLEDGE_BUDGETS.unit.maxModelRequests` 20 → 24 |
| `electron/agentData/knowledgeKernel/executionPolicy.ts` | `page` 20→24；`module-card` 20→28（工具 60→70、token 300000→360000）；`repository-card` 12→24（token 200000→360000、activeTime 10→20 分钟） |
| `electron/agentData/knowledgeKernel/pipeline.ts` | `repository` 加入 `graph.definitions`，使 relations 能把根卡片作为合法端点 |
| `shared/wikiLinks.ts` | `source:` 路径含 `..` 时返回新的 `source-parent` 类型，由调用方决定；`validateStageResult` 明确拒绝 |
| `electron/agentData/knowledgeKernel/validation.ts` | `INVALID_PAGE_LINK` 覆盖 `source-parent` |

测试：`electron/knowledgeProcess` + `electron/agentData/knowledgeKernel` 共 **241 项全绿**（`--maxWorkers=2 --testTimeout=60000`；默认并发下 `incremental.test.ts` 会因 OneDrive 上 git 子进程慢而偶发超时，是既有现象）。

新增用例：正文含代码围栏可解析、只信任末尾围栏、实质回答 → `retriable: true` 而空回答 → `false`、轮次耗尽后仍发出且只发出一次纠正请求。

## 真实运行：五轮，每次的失败点都不同

| 轮次 | 结果 | 失败点 |
| --- | --- | --- |
| 1（改动前基线） | 0 篇 | `card:modules/notes` `INVALID_MODEL_JSON`（20 轮用尽） |
| 2 | 0 篇 | `card:repository` `BUDGET_EXHAUSTED`（12 轮） |
| 3 | 0 篇 | `relations` `INVALID_RELATION`（`repository` 不在 endpoints） |
| 4 | 0 篇 | `card:modules/bin` `INVALID_PAGE_LINK`（`source:../bin/npf`） |
| 5 | 0 篇 | `card:repository` `BUDGET_EXHAUSTED`（13 轮，10 分钟 activeTime 先耗尽） |
| 6 | 0 篇 | `card:architecture` `BUDGET_EXHAUSTED`（24 轮）、`scripts` `INVALID_GENERATION` |

每修好一处，下一次就暴露下一处 —— 说明它们都在同一条路径上，逐个暴露。

## 每轮的实测轮次（第 6 轮）

```
architecture 25  modules/pocock 28  getting-started 27
modules/notes 27  modules/scripts 23  ...
```

几乎所有卡片都跑满或接近预算上限。

## 真正的根因（第 6 轮才看清）

按输出 token 分桶统计 185 次工具调用轮次：

| 输出规模 | 次数 |
| --- | --- |
| < 300 token（基本是「读一个文件」的单行指令） | **101** |
| 300–1500 | 72 |
| > 1500 | 25 |

**56% 的模型轮次只为了发起一次读取。** 提示词要求「把需要的读取合并到一轮」，模型没有照做；`toolExecution: 'sequential'` 只约束同一轮内的执行顺序，不阻止一轮内请求多个工具。

结论：调预算只是把撞墙的位置往后推，真正要改的是**让模型批量请求工具**，或者**让 stage 在观察到足够证据后主动收口**。

## 状态

- 代码侧的解析、分类、纠正通道、端点、链接五处缺陷都已修好并有测试覆盖。
- 真实生成仍未成功（0 篇），因此 5.2 / 5.3 保持未完成。
- 下一步应改提示词与收口策略，而不是继续加预算。
