# Agent Note: 删除 web_search_multi 与 Tavily / Brave 通道

Status: implemented

## Problem

[上一篇收窄](2026-10-21-trim-web-search-surface.md)把 `web_search_multi` 和 Tavily / Brave 留作待人工确认。现在确认全部删除。本机日志里 `web_search_multi` 只有 2 次真实调用，Tavily / Brave 的 key 没配过，调用为 0。`web_search_multi` 的名字散在五处白名单和 UI 卡片里，Tavily / Brave 带着 `answer` 字段、两套响应解析和两个设置项。

## Decision

`web-search` 扩展只剩一个工具 `web_search(query, maxResults?)`，只有抓取式引擎。

- 删除 `web_search_multi` 工具及 `searchService.ts`（并行聚合、限额分配）、`resolveSearchEngines`、`buildEngineExecutors`。
- 删除 Tavily / Brave：`tavilySearch`、`braveSearch`、`parseTavily`、`parseBrave`、`ProviderChoice` 里带 `apiKey` 的分支，`resolveProvider` 不再读 `TAVILY_API_KEY` / `BRAVE_API_KEY`。设置页移除这两个输入项。
- `ParsedSearch.answer` 只有 Tavily 会填，随之删除，`formatResults` 不再输出摘要段。
- 白名单与 UI：`_shared/tool-groups.ts`、`agent-mode/modes.ts` 去掉 `web_search_multi`；`extensionCards.tsx` 删 `MultiSearchCard` 和注册项，`ToolExecution.tsx`、`toolUtils.ts` 去掉该名字，`preview.tsx` 去掉对应样例。
- `web_search` 的返回 `details` 字段（`query`、`provider`、`engines?`、`count`、`results`、`error`）不变；`WEB_SEARCH_PROVIDER` 和 `WEB_SEARCH_ENGINES` 保留，值只认 `bing`、`sogou`、`baidu`、`duckduckgo`，其他值（含 `tavily`、`brave`）回落到 `bing`。
- 限定站点靠查询里的 `site:` 运算符，写进了 `web_search` 的描述。

## Alternatives considered

- 只删 `web_search_multi`，留 Tavily / Brave。最强理由是 API 通道不靠抓页面，Bing 页面结构一变就失效时它是兜底。不选它，因为没人配 key，兜底只存在于代码里，却要多维护两套解析和一个 `answer` 字段。
- 把 `web_search_multi` 折进 `web_search`（加 `engines` 参数）。最强理由是保留并行聚合能力。不选它，因为 2 次调用不值得让主工具的 schema 变复杂，用户也明确要求整体删除。

## Consequences

收益：`web-search` 现在 682 行（含测试），一个工具、四个引擎、一条回退链，没有 API key 配置，也不用在白名单里同步两个名字。代价：失去并行多引擎聚合；失去不靠抓页面的搜索通道，Bing / 搜狗 / 百度页面结构变化时 `web_search` 会直接返回无结果；已经保存过的 `TAVILY_API_KEY` / `BRAVE_API_KEY` 设置值会留在配置文件里，没人读它。旧会话里 `web_search_multi` 的历史卡片会按通用工具卡片显示。模型若仍调用 `web_search_multi`，会得到"工具不存在"。

## 验证

- `cd extensions && npx vitest run web-search _shared agent-mode safety prompt-metadata`：66 个文件（2 个跳过）644 个用例通过。
- `cd extensions && npx vitest run multi-agent im-platforms mcp`：`multi-agent/runner.test.ts` 的 `resolveSubagentModel` 三个用例失败，上一篇已验证它们在本次改动之前就失败；其余 59 个文件通过。
- `cd electron-agent && npx vitest run src/features/tools src/features/settings`：33 个文件 321 个用例通过。
- `cd electron-agent && npx tsc -p tsconfig.node.json --noEmit`：155 个既有错误，与改前逐行比对没有新增。
- verify: n/a 只删除了一张卡片的注册和设置页两个输入项，没有新增交互；现有 ui-harness 场景没有覆盖搜索卡片，未运行。
