# Agent Note: 模型输出解析按形状分类，格式失败可重试而空回答不可

Status: implemented

## Problem

Repo Wiki 与知识卡各自有一套"模型回答 → 结构化对象"的解析，两者对真实模型的输出都过于严格，且**失败时无法区分原因**。

三类真实输出被误判：

1. **catalogue 的单个 section 对象。** 模型返回 `{"title":…,"name":"01-overview",…}` 而不是 `[{…}]`。解析器只认数组，整次生成失败，错误码 `CATALOGUE_CHILD_OUTPUT_INVALID`。
2. **字符串值内的未转义引号。** section prompt 里有 `--cmd "真实验收命令"`，JSON.parse 在 offset 4596 报错。`repairJson()` 处理不了这一类。
3. **知识卡的正文含围栏代码块。** `{"markdown":"说明\n```js\nconst a = 1;\n```\n"}` 是合法 JSON，但解析器的候选顺序是「整段 → ``` 围栏 → 首 `{` 到末 `}`」，第二个候选把正文里的 ``` 当成外层围栏，切出无效片段。

更严重的是失败分类：知识卡的 `INVALID_MODEL_JSON` 一律 `retriable: false`，协调器的 `maxAttempts: 2` 形同虚设。模型"答了但格式不对"与"什么都没答"被当成同一类，都是永久失败。

## Decision

**一、解析只做无损归一，不放宽结构校验。**

Repo Wiki（`wikiService/referenceParsers.ts`）：

- 候选顺序为「原样 JSON → `repairJson()` → `repairUnescapedQuotes()`」。第三层只处理"引号后面不是 `,` `}` `]` `:`"，且必须整体 `JSON.parse` 通过才返回；`inString` 未闭合直接放弃。
- `sectionsFrom()` 归一顶层形状：数组原样；裸对象自带 `items` 用 `items`；带 `title`/`name` 视为单元素目录。
- 字段级仍然严格：`title`/`name`/`prompt` 必须非空字符串，同名兄弟报错。

知识卡（`knowledgeProcess/stageRuntime.ts` 的 `parseStageJson`）：

- 候选顺序改为「首 `{` 到末 `}` → 整段 → 仅末尾围栏」，因为正文含代码块时**外层对象**才是答案。
- 围栏候选额外要求切出的对象含该阶段的顶层键（`markdown`/`summary`/`items`/`children`/`relations`/`valid`），否则视为正文里的代码。

**二、失败按"是否有实质回答"分类。**

最后一条模型消息超过 256 字节 → `retriable: true`（格式失败，值得再试）；空回答或供应商错误 → `false`。协调器既有的 `error.retriable && stageAttempt < maxAttempts` 因此真正生效。

**三、解析失败时给一次纠正，且不计入轮次。**

轮次预算耗尽后仍发一次 `Reply again with only that JSON object`。这次请求不计入 `modelTurns`，否则会触发 `BUDGET_EXHAUSTED`。只给一次，不循环。

**四、`source:` 链接的 `..` 由调用方判定。**

`source:../bin/npf#L1-L8` 是模型复用了页面目录，不是逃出仓库。`shared/wikiLinks.ts` 新增 `source-parent` 类型报告字面前缀，`normalizeStageSources` 与 `validateStageResult` 各自决定：前者移除、后者拒绝。

**五、catalogue 的自我回显改为无损折叠。**

子节点重复父节点名字（`README > README > README > installation`）时，`normalizeCatalogueTree()` 丢弃同名的包装节点并提升其子树。真实树 67 → 63 节点，安装页与 CLI 页保留。

**这一点刻意不选"拒绝"**：两次都回显会让整次生成失败，那是能力退步。

**六、relations 的端点包含 `repository`。**

`repository` 是真实存在的卡片节点但不是 plan 定义，模型把根卡片当枢纽是合理的。加入 `graph.definitions` 后 `INVALID_RELATION` 消失。

## Alternatives considered

- **把字段类型放宽成任意值** — 能接受更多输出。否决：下游 `has_children.toLowerCase()` 这类用法会静默走偏，得到一棵看起来能用的错树。
- **只认数组、其余一律重试** — 保持严格。否决：真实数据里 8 条 child 响应有 2 条是单对象，成本是整次生成失败；且重试不保证换形状。
- **用真正的 JSON 扫描器定位边界**（如 `scanJsonValue`）— 更可靠。暂缓：需要移植并覆盖流式与深度限制，改动面大于本轮的"候选重排 + 顶层键校验"。已知形状已被覆盖。
- **自我回显直接 reject** — 语义上最严格，也最符合"模型必须守约"。否决：Qoder 的提示词明确禁止，但真实模型仍然违反；拒绝会让违反变成整次失败，而折叠是信息无损的。
- **把 `source:../x` 直接放宽为合法** — 一行改动。否决：`source:` 路径是仓库根相对的，任意级数上跳若被接受，会让越界引用静默通过。区分"前导 `..`"与"内部 `..`"才既不误伤也不放宽。
- **`INVALID_MODEL_JSON` 一律可重试** — 最简单。否决：空回答与鉴权失败重试没有意义，会白烧额度。

## Consequences

- **收益**：真实 4 份失败响应从 2/4 解析成功变为 4/4；知识卡从 0 篇到 10/10 发布。
- **收益**：失败码现在能区分"模型错"、"输出被截断"、"输出格式不合规"三种，`stageFailureCode()` 与 `error.retriable` 各自承载。
- **代价**：解析确实比只认一种形状宽松。限制是"仅在 JSON 完全不可用时才尝试修复"、"修复必须整体 `JSON.parse` 通过"、"截断与结构损坏仍然失败"，并有反例用例固定这些边界。
- **代价**：自我回显折叠会让目录比模型原本的意图少一层。当折叠后某个父节点的子树为空时，该父节点本身仍保留页面。
- **必须重访的信号**：若出现新的真实失败响应形状，先补夹具再改逻辑；不要凭猜测放宽。

## Verification

- `npx vitest run --project main electron/wikiService`：15 文件 83 项通过，含单对象、自带 `items`、未转义引号、截断仍失败、自我回显折叠五个新用例。
- `node --import tsx scripts/verify-repo-wiki-catalogue.mjs`：4/4 真实响应解析成功，端到端 9 文件 49 项通过。
- `npx vitest run --project main electron/knowledgeProcess electron/agentData/knowledgeKernel --maxWorkers=2 --testTimeout=60000`：244 项通过，含正文含代码块可解析、只信任末尾围栏、实质回答可重试、空回答不可重试四个新用例。
- 端到端：Repo Wiki 20/20 发布（`.agents/evidence/2026-11-04-repo-wiki-real-run/REPORT.md`），知识卡 10/10 发布（同目录 `cards-fixed.md`）。
