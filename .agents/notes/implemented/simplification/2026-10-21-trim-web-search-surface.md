# Agent Note: 收窄 web-search 能力表面（去 fetchTop 与五个小众引擎）

Status: implemented

后续：待确认的 `web_search_multi` 与 Tavily / Brave 已在 [删除 web_search_multi 与 Tavily / Brave 通道](2026-10-21-remove-web-search-multi-and-api-providers.md) 中删除，下文"保持不变"一节里这几项以新篇为准。

## Problem

`extensions/web-search` 对外有两个工具，背后是 2 个 API provider 加 9 个抓取式引擎，总计约 1200 行（含测试）。本机 925 份会话日志里，两个工具一共只被真实调用 5 次（`web_search` 3 次、`web_search_multi` 2 次），`fetchTop` 一次没用过，`exa` 唯一一次调用失败，`csdn` / `juejin` / `linuxdo` / `zhihu` 从未用过。这几个引擎靠无文档的私有接口或页面结构维护，成本高于收益。

## Decision

对外接口清单（本次之后）：

- 工具 `web_search(query, maxResults?)`。返回 `content` 为 markdown 链接列表；`details` 为 `{ query, provider, engines?, count, results[{title,url,snippet}], error? }`。
- 工具 `web_search_multi(query, limit?, engines?)`。`details` 为 `{ query, provider: "multi", engines, count, partialFailures, results }`。
- 配置键 `WEB_SEARCH_PROVIDER`、`WEB_SEARCH_ENGINES`、`TAVILY_API_KEY`、`BRAVE_API_KEY`，环境变量 `WEB_SEARCH_TIMEOUT_MS`。
- 依赖方：`_shared/tool-groups.ts`（联网工具名单）、`agent-mode/modes.ts`（只读模式白名单）、`electron-agent` 的 `extensionCards.tsx` / `ToolExecution.tsx` / `toolUtils.ts`（卡片读 `details.provider`、`engines`、`results`、`count`、`error`）、设置页 `settingsSchema.ts`。

本次裁撤：

- `web_search` 去掉 `fetchTop` 参数和内部的正文抓取。取正文由 `fetch_url` 负责，`web-search` 也不再 import `web-fetch` 与 `web-crawler`。
- 去掉 `exa`、`csdn`、`juejin`、`linuxdo`、`zhihu` 五个引擎，连同 `engines/exa.ts`、`csdn.ts`、`juejin.ts`、`site.ts` 和对应测试。保留 `bing`、`sogou`、`baidu`、`duckduckgo`。限定站点改用查询里的 `site:` 运算符，`web_search_multi` 的描述里写明了这一点。
- 已移除的引擎名按未知值处理：`parseEngineChain` 丢弃，`WEB_SEARCH_PROVIDER` 回落到 `bing`，`web_search_multi` 的 `engines` 里全是已移除的名字时回落到默认的 `bing,baidu`。

保持不变：两个工具名、`query` / `maxResults` / `limit` / `engines` 参数、上面列出的 `details` 字段、四个配置键、`searchService.ts`、Tavily / Brave 通道、默认回退链 bing → sogou → baidu。

## Alternatives considered

- 删掉 `web_search_multi`。最强理由是它与 `web_search` 重叠，且只有 2 次真实调用，可以再删 `searchService.ts` 和 `MultiSearchCard`。不选它，因为它的并行聚合是 `web_search` 的回退链做不到的，而且工具名写在 `tool-groups`、`agent-mode`、UI 卡片和历史会话回放里，删了会让旧会话退化成通用卡片。列为待人工确认。
- 删掉 Tavily / Brave。最强理由是本机两个 key 都没配、调用为 0，还能顺带删掉 `answer` 字段。不选它，因为它们是唯一不靠抓页面的通道，别的机器上有没有人配了 key 从代码里确认不了。列为待人工确认。
- 删掉 `duckduckgo`。最强理由是国内网络常被墙。不选它，因为日志里有一次显式使用，且它是唯一的非 Bing 系海外引擎。
- 保留 `fetchTop`。最强理由是一次调用省一次工具往返。不选它，因为调用为 0，而且 `fetch_url` 已覆盖，这个参数是 web-search 对抓取模块的唯一耦合。

## Consequences

收益：`web-search` 去掉约 250 行实现和测试，少三个私有接口适配，不再依赖抓取模块。代价与风险：模型如果还按旧提示传 `engines: ["exa"]` 或 `fetchTop`，前者静默回落到默认引擎，后者被忽略（schema 未设 `additionalProperties: false`），表现为"没有正文"而不是报错；`cheerio` 仍被 `baidu` 使用，依赖不变；`mcp/config.ts` 里可选注入的 `open-websearch` 服务（`OPEN_WEBSEARCH=1`）与本扩展无关，没有动。使用量数字只来自本机日志，别的机器的实际使用情况待确认。

## 验证

- 基线与改后：`cd extensions && npx vitest run web-search`，3 个文件 24 个用例，结果通过；新增用例锁定两个工具的参数名集合。
- `cd extensions && npx vitest run web-search agent-mode _shared multi-agent im-platforms prompt-metadata safety`：1 个文件失败，是 `multi-agent/runner.test.ts` 的 `resolveSubagentModel` 三个用例；`git stash` 掉本次改动后同样失败，与本次无关。其余 103 个文件通过。
- `cd electron-agent && npx tsc -p tsconfig.node.json --noEmit`：改前改后都是 155 个既有错误，逐行比对没有新增。
- verify: n/a 没有 UI 改动，卡片读取的 `details` 字段未变。
