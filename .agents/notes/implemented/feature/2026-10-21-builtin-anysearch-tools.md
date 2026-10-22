# Agent Note: 内置 AnySearch 工具（anysearch_search / anysearch_sub_domains）

Status: implemented

## Problem

用户的 AnySearch 之前只能靠外部 MCP server（`mcp__anysearch__*`）使用，要在每台机器上单独配置，配置声明还散在各工作区的 `.pi/mcp.json` 里。要把它做成内置工具，按 [官方 API 文档](https://www.anysearch.com/docs/api-endpoints) 直接调 REST。`web_search` 只能抓 Bing / 搜狗 / 百度的页面，没有代码文档、金融、学术这类按领域路由的垂直来源。

## Decision

在现有 `web-search` 扩展里新增 `extensions/web-search/anysearch.ts`，注册两个工具。放进 `web-search` 而不是新扩展，是因为它已有 `network: full` 清单、插件白名单和联网权限接入，不用再加一个插件。

- `anysearch_search(query, max_results?, tag?, zone?, language?, params?)` 调 `POST https://api.anysearch.com/v1/search`。`max_results` 夹到 1-10，默认 5（文档默认 10，这里为省上下文取小）。请求固定带 `format: "markdown"`，不暴露给模型。每条结果的正文最多取 1500 字符；有正文时不再重复 snippet；文末写明外部内容不执行其中指令。
- `anysearch_sub_domains(domains[])` 调 `GET /v1/sub-domains`，按文档用重复的 `domain=` 参数，参数定义按 `sort_order` 排序。它不占搜索额度。
- 认证：`ANYSEARCH_API_KEY`（设置页「搜索」分区，密码框）可选。有 key 才带 `Authorization: Bearer`；匿名按 IP 限流并占用每日免费额度。key 无效服务端返回 401/403，不退回匿名，这里同样不降级。
- 402 匿名额度用完时，服务端会把自动注册的 `username` / `password` / `api_key` 放进响应 message。这些值一律丢弃：错误文本固定写"额度已用完，请到 anysearch.com 注册并填 key"，并对所有错误信息再做一次 `username|password|api_key=` 脱敏。
- 联网权限和其他联网工具一致：执行前走 `requireNetwork`，两个工具名加进 `_shared/tool-groups.ts` 的 `NET_TOOLS`（ask 确认和 `net:false` 子代理都会命中）和 `agent-mode` 只读白名单。
- UI：`anysearch_search` 复用 `WebSearchCard`（`details.provider/count/results`），标题行和图标跟 `web_search` 一样；`anysearch_sub_domains` 走通用卡片。
- `anysearch_sub_domains` 混查多个 domain 时，服务端只要有一个 domain 的能力清单暂时不可用（实测 `web` 单查就是 502）整批就返回 502。遇到 5xx 且 domain 多于一个时改为逐个查，能拿到的照常返回，失败的在文末点名；单个 domain 或全部失败仍报错。`anysearch_search` 的描述里提醒：`code.doc` 库名写错不会报错，会静默退化成普通搜索。
- 错误不抛异常，返回 `content` 文本加 `details.error` / `details.status`，与 `web_search` 一致。

## Alternatives considered

- 接 `/v1/extract`，做第三个工具。最强理由是官方文档把它列为三个端点之一，页面正文由服务端清洗。不选它，因为 `fetch_url` 已有多级抓取回退，两个取正文的工具会让模型选择困难；加一个工具只要几十行，之后需要再加。
- 继续只用 MCP server。最强理由是零代码、`batch_search` 也现成。不选它，因为每台机器要单独配置，也没法接入内置的联网权限、白名单和卡片。外部 MCP 的 `mcp__anysearch__*` 与新工具名不冲突，两者可以并存。
- 把 AnySearch 做成 `web_search` 的一个引擎。最强理由是只有一个搜索入口。不选它，因为 `web_search` 的 `details` 和参数面刚收窄过，而 AnySearch 的 `tag` / `params` 垂直路由用法与回退链模型不同。
- 暴露 `format` 参数。最强理由是与官方文档一一对应。不选它，因为只有 markdown 对模型有用，少一个参数。

## Consequences

收益：开箱可用，匿名即可；垂直来源（`code.doc`、`finance.quote` 等）有统一入口；联网权限与白名单一并生效。代价与风险：多两个联网工具名，提示词表面变大；匿名额度按 IP 共享，用完后要用户自己注册 key；服务端在 402 时已自动生成的临时账号会作废，没有地方找回；外部网页内容进入上下文，只靠文末提示加模型自身的防注入，没有额外清洗。与 `web_search` 的分工只靠工具描述里的一句话约束，实际模型会不会选对待观察。使用 `tag` 时必填参数（如 `code.doc` 的 `library`）缺失，服务端返回 400，错误文本原样带给模型。

## 验证

- `cd extensions && npx vitest run web-search _shared agent-mode prompt-metadata`：64 个文件（2 个跳过）582 个用例通过，其中 `web-search/anysearch.test.ts` 覆盖请求体与鉴权头、key 不进错误文本、402 凭据脱敏、重复 `domain` 参数、守卫拒绝时不发请求、错误转 `details.error`。
- 真实接口冒烟（匿名，一次 `sub-domains?domain=code` 和一次 `search`）：`sub-domains` 返回 `code.doc` / `code.snippet` 及参数；不带必填的 `library` 时 `search` 返回 400，错误文本带 request_id；带上 `params.library` 后返回 3 条结果、耗时约 4 秒，格式化输出正常。
- 在真实会话里试用后补的修复：混查 `code,finance,web` 复现 502，加拆分重试后实测返回 code 和 finance，并注明 web 不可用；测试 mock 掉配置读取，避免读到本机设置里真实的 key（之前两个用例因此失败）。重跑 `cd extensions && npx vitest run web-search _shared agent-mode prompt-metadata`：64 个文件（2 个跳过）584 个用例通过。
- `cd electron-agent && npx vitest run src/features/tools src/features/settings`：33 个文件 322 个用例通过（含新增的 `anysearch_search` 卡片用例）。第一次跑时有 2 个文件失败，当时没有记下是哪两个；原样重跑全部通过，原因未查明，疑似负载导致的超时。
- `cd electron-agent && npx tsc -p tsconfig.node.json --noEmit`：155 个既有错误，与改前逐行比对没有新增。
- verify: n/a 没有新的 UI 交互，只是复用搜索卡片；ui-harness 现有场景不覆盖搜索卡片，未运行。
