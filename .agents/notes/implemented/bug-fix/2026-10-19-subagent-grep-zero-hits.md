# Agent Note: 子代理的 grep 卡不再一律显示「0 处 / 未找到匹配」

Status: implemented

## Problem

子代理里的每一次 grep，折叠行都写「检索 X · 0 处」，展开后是「未找到匹配」。用户看到的就是子代理检索全部落空。模型拿到的结果其实是完整的：2026-10-18 的几个子代理会话里 53 条 grep 结果都有命中，坏的只是界面。

原因是格式对不上。命名代理（scout 等）的白名单里是 pi 内置的 `grep`，pi 1.3.0 的 `core/tools/grep.js` 逐行输出：

- 匹配行：`<path>:<N>: <text>`
- 上下文行（`context > 0` 时）：`<path>-<N>- <text>`
- 末尾提示放在方括号里：`[100 matches limit reached. ...]`
- 没有命中时：`No matches found`

渲染层的 `parseGrepOutput`（`electron-agent/src/lib/searchResults.ts`）只认 opencode 的分组格式（`Found N matches` / `<path>:` / `  Line N: text`），pi 的输出一行都对不上，`files` 是空数组、`total` 是 0。折叠行的计数（`ToolExecution.tsx` 的 grep 分支）和展开后的 `GrepCard` 共用这个解析器，所以两处一起变成 0。主会话不受影响，因为它不注册 `grep`，代码检索走的是自己的 `search` 工具，用 `parseCodeSearch` 读 `details.matches`。

## Decision

`parseGrepOutput` 两种格式都认：

- opencode 的分组格式保持原样。
- pi 的逐行格式按路径归组，顺序沿用第一次出现的位置。匹配行进 `matches`，上下文行也进，但带 `context: true`。
- `total` 只数匹配行，上下文行不算。
- 方括号里带 `limit reached` 的提示把结果标成截断。
- `No matches found` 不产生任何行。

路径段用懒匹配（`^(.+?):(\d+): ?(.*)$`），所以 Windows 盘符的冒号、文件名里的连字符都不会被当成分隔符。`GrepCard` 把上下文行画成 `N- text`，匹配行仍是 `N: text`，和 rg 的习惯一致。

## Alternatives considered

- **把 pi 内置 grep 换成我们自己的 `search`，或者给子代理注册一份 opencode 格式的 grep**：这样渲染层只需要认一种格式，主会话和子代理的卡片也会完全一样，这是最强的理由。不这么做，是因为命名代理的白名单写的就是 `grep`，模型对 pi 内置工具的参数和输出都很熟。为了界面去换模型侧的工具，改动面更大，还会影响子代理怎么检索。界面问题就在界面里修。
- **读 `details` 而不是文本**：`search` 就是这样做的。可 pi 的 grep 没有结构化结果，`details` 只有 `matchLimitReached` / `truncation` / `linesTruncated`，只能解析文本。
- **去掉 opencode 格式的分支**：现在没有工具产出这种格式了。但历史会话里可能还有，留着它成本很低，去掉的话旧会话回放会变成 0。

## Consequences

子代理里的 grep 卡会写出真实的命中数，展开后按文件分组，带行号和上下文行。命中达到上限时，卡片写「结果较多，已截断显示」。

折叠行的「N 处」只数匹配行，最多就是 pi 的 `limit`（默认 100）。被截断时这个数字是下限，不是总数，因为 pi 不报告上限之外还有多少条。

路径本身含有 `:<数字>: ` 这样的片段时会被拆错。实际路径里几乎不会出现，没有专门处理。

pi 以后要是再改 grep 的输出格式，这里还会悄悄变回 0。`searchResults.test.ts` 和 `subagent-conversation` 场景里的样本是照 1.3.0 的 `grep.js` 造的，升级 pi 时要对一下。

## Verification

结果：通过。

- `cd electron-agent && npx vitest run src/lib/searchResults.test.ts src/features/tools/ToolExecution.test.tsx src/features/tools/SearchCards.test.tsx`：先加的 3 条 pi 格式用例在旧解析器下失败（`expected +0 to be 3`），改完后全部通过。连同 `codemodeWorkerBuild.test.ts`，一共 4 个文件、77 条用例通过。
- 回放真实数据：`npx tsx .agents/evidence/2026-10-19-subagent-grep-zero-hits/grep-replay.ts <4 个子代理会话>`，输入是 2026-10-18 的子代理会话（`sa-8f48d411`、`sa-48e60664`、`sa-b8bc70e1`、`sa-40adf290`），输出 `{ grepResults: 53, realNoMatch: 0, parsedAsZero: 0 }`。旧解析器下这 53 条全是 0。
- `cd electron-agent && node ui-harness/check.mjs subagent-conversation`：新增「子代理 pi grep」模式，全部 PASS。有命中的行写「检索 CodeRetrievalPanel · 2 处」，真正 `No matches found` 的那行写「0 处」。展开后是 `card-grep`，有 `39: export function CodeRetrievalPanel`、上下文行 `40- `，有截断提示，没有「未找到匹配」。日志和截图在 `.agents/evidence/2026-10-19-subagent-grep-zero-hits/`。
- 只跑了 `subagent-conversation`。`--changed --dry-run` 列出 21 个受影响场景，其中大部分是工作区里别的未提交改动带进来的。这次只改了 grep 的解析和显示，别的场景没跑。
