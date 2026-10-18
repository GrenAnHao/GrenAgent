# Agent Note: search 工具必填参数改成字符串 pattern，并在校验前归一误用

Status: implemented

## Problem

几乎每次对话都会出现一两行红色的「检索 · 未找到匹配」。查本机 897 个会话日志（`~/.pi/agent/sessions`），`search` 共 2090 次调用，14 次没过 pi 的参数校验：

- 13 次模型发来的 arguments 就是 `{}`，全部来自同一个 Claude 供应商（`custom-muqywnc8`，sonnet-5-5 11 次、opus-5-5 2 次），其中 8 次集中在最近三天，常常一个并行批次里两个 `search` 同时为空。
- 1 次是 DeepSeek 用错字段名：`pattern`（字符串）、`paths`、`includePatterns`。

同一供应商上按工具对比 `{}` 失败率，差别在必填参数的类型：

| 工具 | 必填参数 | 调用 | `{}` 失败 |
| --- | --- | --- | --- |
| bash | `command` 字符串 | 10333 | 0 |
| read | `path` 字符串 | 6917 | 2 |
| read_files | `files` 数组 | 367 | 1 |
| search | `patterns` 数组 | 1667 | 13 |

已排除的解释：代理丢流式增量会均匀打到所有工具，但 bash 一次都没有；正则反斜杠弄坏 JSON 也不成立，738 次成功的 `search` 参数里带反斜杠，而且 pi-ai 的 `parseStreamingJson` 本身会修非法转义。失败那次的下一轮重试都带着完整参数，说明是模型这一次生成了空调用，不是传输层吃掉了参数。

另一个现象：卡片把 pi 的 `Validation failed ...` 文本当成文件路径解析，结果显示「未找到匹配」，真正原因被藏住。这一处已在同批改掉（`CodeSearchCard` 在 `status === 'error'` 时原样显示返回文本）。

## Decision

`extensions/batch-tools/search.ts`：

- 必填参数是字符串 `pattern`（第一个字段）；`patterns` 变成可选数组，和 `pattern` 一起 OR。执行时用 `searchPatternList` 合并去重。
- 注册 `prepareArguments: prepareSearchArguments`，pi 在 schema 校验前调用。它把 `pattern` / `patterns` / `query` / `regex` / `regexp`（字符串或数组）合并去重，第一个进 `pattern`、其余进 `patterns`；`glob` / `include` / `includes` / `includePatterns` / `filePattern(s)` 归到 `globs`；`paths` 或数组形式的 `path` 取第一个。旧会话里的 `{ patterns: [...] }` 也照此转成新形状。
- 一个 pattern 都没有（例如 `{}`）时原样返回，由 schema 报「缺 pattern」，模型照常重试。空调用里没有可以恢复的信息，不在这里伪造参数。
- promptGuidelines 写明「search always needs pattern」；`fable-behavior/prompts/tier2/grep-strategy.md` 的参数说明同步，`grep` 和 `search` 现在都以 `pattern` 为主参数。

`electron-agent/src/features/tools/ToolExecution.tsx` 的标题摘要同时读 `pattern` 和 `patterns`，新旧会话都能显示检索式。

## Alternatives considered

- **只加 prepareArguments，保持 `patterns` 必填数组。** 最强理由：不动对外契约，零迁移成本，已经能消掉 DeepSeek 那类失败。不选：它对占 13/14 的 `{}` 毫无作用，而表里最强的相关因素就是必填数组。
- **改提示词，强调「必须传 patterns」。** 最强理由：最便宜，不碰代码。不选：失败的调用里模型并没有传错字段，而是什么都没传，属于生成层面的偶发，再加一句纪律没有着力点；Guidelines 里每多一条都会撑大系统提示。
- **在 prepareArguments 里给 `{}` 兜底（比如从上下文猜一个 pattern）。** 不选：猜出来的检索比失败更糟，模型会以为「没有命中」并据此下结论。
- **开 `constrainedSampling`（pi 的 edit 工具用的 json_schema 约束采样）。** 最强理由：从采样层面保证必填字段存在。没选：依赖供应商支持，走第三方 Claude 代理时是否生效无法确认，先用不依赖供应商的办法。

## Consequences

- 收益：DeepSeek 式字段名误用直接被归一，不再浪费一轮；必填参数换成和 bash / read 同类的字符串，预期 `{}` 率下降。
- 代价：`search` 的 schema 变了。模型直接调用时靠 prepareArguments 兼容旧形状。codemode 脚本里的 `tools.search(...)` 不走 pi 的校验，也不调 prepareArguments（pi 1.x 只在 agent loop 的 `prepareToolCall` 里调用），参数原样进 `execute`；`execute` 用 `searchPatternList` 同时读 `pattern` 和 `patterns`，所以旧写法 `tools.search({ patterns: [...] })` 仍然能用，但 `query` 这类别名在 codemode 里不生效。
- 风险：字符串必填降低 `{}` 率目前只是相关性推断。复查方法：过几天用同样的日志扫描脚本（按 provider × tool 统计 arguments 为 `{}` 且 `Validation failed` 的比例）看 `search` 是否降到 read 的量级；没降就说明不是参数类型的问题，再评估 constrainedSampling。

## 验证

- `cd extensions && npx vitest run batch-tools/search.test.ts prompt-metadata.test.ts`：16 passed（含 prepareSearchArguments 对旧形状、单字符串、DeepSeek 误用样本、别名去重、`{}` 原样返回的用例）。
- `cd electron-agent && npx vitest run src/features/tools/ToolExecution.test.tsx src/features/tools/SearchCards.test.tsx`：56 passed（含新 schema 标题合并、校验失败显示 pi 报错而不是「未找到匹配」）。
- `search.ts` 用临时 strict tsconfig 跑 tsc：无报错。
- 失败率复查要等新会话积累，见 Consequences 的复查方法；本次没有 ui-harness 场景覆盖 search 卡片，卡片改动只靠 vitest。
