# Agent Note: 工具输出被截断不再让整个阶段失败

Status: implemented
Archived: 2026-11-13

## Problem

真实仓库生成 Wiki 时报「生成失败（INCOMPLETE_TOOL_OUTPUT）」。`stageRuntime` 只要本阶段任何一次工具结果被截断（Read 超过 400 行或 32 KiB、Glob/ListDir 超过 200 项、Grep 超过 100 行匹配）就直接判失败。真实仓库几乎每个阶段都会碰到长文件或大目录，所以生成基本跑不完。模型看到的截断标记也只有 `[truncated]`，不知道怎么取剩下的部分。

另一个隐患：Read 按字节上限截断时，证据仍记录为请求的整段行号，引用校验会放行模型没见过的行。

## Decision

- 截断只是部分结果，不算失败。工具在结果末尾写明怎么继续：Read 给出「已显示第 a-b 行，共 N 行，用 offset=b+1 继续」，Glob/Grep/ListDir 提示缩小路径或模式。系统提示同步说明。
- Read 先按字节预算截取整行，再记录 `startLine..endLine`，保证记录的范围就是模型实际收到的行。
- 正确性仍由协调器的 `validateStageResult` 保证：`overview`、`generate`、`relations` 的来源和 Markdown 中的 `source:` 链接必须落在 Read 实际返回的行范围内，否则判失败。

### 同类问题：最终答复外包了 ```json

之后真实模型在「项目概览」返回了 ```` ```json {...} ``` ````，`stageRuntime` 直接 `JSON.parse` 失败，界面显示 `Unexpected token '`'`。现在 `parseStageJson()` 依次尝试原文、代码块内容、首个 `{` 到最后一个 `}`；仍然不是对象时，若还有模型轮数，就追问一次「只返回 JSON 对象」，再失败才报 `INVALID_MODEL_JSON`。结构校验仍在协调器。

## Alternatives considered

- 提高各项上限：最省改动；不采用，大仓库仍会超过任何固定上限，还会抬高单次请求的 token 消耗。
- 保留失败，但只针对 Read：最保守；不采用，Read 截断本身也不让结论变假，引用范围校验已经挡住没读过的行，硬失败只会让长文件无法被引用。

## 验证

- `pnpm exec vitest run electron/knowledgeProcess electron/agentData/knowledgeKernel`：21 文件 123 项通过，包括新增的分段 Read 继续读取，以及字节截断后行范围与实际内容一致。
- `pnpm exec vitest run electron/app/repoWikiKnowledgeKernel.integration.test.ts electron/app/repoWikiService.test.ts electron/app/repoWikiTasks.test.ts`：3 文件 28 项通过。
- JSON 外包裹修复后：`pnpm exec vitest run electron/agentData/knowledgeKernel electron/knowledgeProcess src/features/repoWiki`：25 文件 183 项通过，含代码块/前后有说明文字的解析和一次追问重发。
- 日志在 `.agents/evidence/2026-11-01-repo-wiki-partial-tool-output/`。未用真实模型重跑。

## Consequences

模型可以分段读长文件，因此一个阶段的工具调用次数会增加，仍受每单元 40 次工具调用、12 轮模型调用的预算限制；预算耗尽会以 `BUDGET_EXHAUSTED` 阻塞并保留成果。
