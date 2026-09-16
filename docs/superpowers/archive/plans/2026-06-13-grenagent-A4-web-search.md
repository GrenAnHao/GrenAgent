# A4 Web Search 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 为 GrenAgent/Pi 增加 `web_search` 工具：调用搜索引擎（默认 Tavily，可配 Brave），返回「摘要 + 结果链接列表」；可选对 top 结果复用 `fetch_url` 取正文。前端 `WebSearchCard` 展示结果列表，输入区加「联网搜索」快捷按钮。

**父 spec：** `docs/superpowers/specs/2026-06-13-grenagent-subproject-a-extensions-safety-design.md`（§4.7 模块 4：web search）

---

## 实施状态（2026-06-13）

A4 全部 7 个任务完成（含可选任务 6），逐任务提交：

- ✅ 任务 1 纯函数 + 单测（8/8）：`3cec38b`
- ✅ 任务 2 web_search 工具（tavily/brave + 可选取正文）：`a0695f1`
- ✅ 任务 3 注册 + 重建（4887 modules，无 Could not resolve）：`77a05bd`
- ✅ 任务 4 settings 搜索 key（分类标题改「网页 / 搜索 / 子代理」）：`10bcba2`
- ✅ 任务 5 WebSearchCard（extensionCards 测试 11/11 + 前端 tsc 0）：`7e1923f`
- ✅ 任务 6 输入区「联网搜索」快捷：`cf9cf3f`
- ◐ 任务 7 端到端：print 模式实跑确认 agent **成功发出 `toolCall web_search`**（工具注册 + 调用已验证）；`resolveProvider` 降级由任务 1 单测覆盖。**待用户在 app 内**配置 TAVILY/BRAVE key 验证真实搜索结果 + WebSearchCard 渲染。

> 下方为原始计划步骤（复选框保留为原始拆解；实际完成情况以本节为准）。

---

## 关键发现（实现前排查）

1. **`extensions/web-fetch/` 是工具模板**：`pi.registerTool({ name, label, description, promptSnippet, parameters: Type.Object({...}), execute })`，返回 `{ content:[{type:"text",text}], details }`。零依赖（Node `fetch` + 正则）。A4 同构。
2. **`fetch_url` 可直接复用取正文**：web-fetch 的 `execute` 逻辑封装在工具里。A4 取正文走「调用 `fetch_url` 工具」需要 `ctx`/工具调用能力；MVP 更简单的做法是 web-search 内部直接 `fetch` + 复用 web-fetch 的 `html.ts`（`htmlToMarkdown`/`isSafeUrl`）。
3. **opencode websearch 借鉴**（`MiMo-Code/packages/opencode/src/tool/websearch/`）：
   - `index.ts`：provider 分流（xiaomi mimo / Exa）+ 参数（query/numResults/type/livecrawl）。
   - `mimo.ts` 的 `formatSources(annotations)`：把结果格式化为 `Sources:\n- title · site · time\n  url\n  summary` —— 这是个干净的纯函数，A4 的 `formatResults` 直接借鉴。
   - 注意 opencode 用 Effect + zod；我们用普通 async + typebox（对齐 web-fetch）。
4. **provider 选择**：spec 定 Tavily 默认、Brave 可选。
   - Tavily：`POST https://api.tavily.com/search`，body `{ api_key, query, max_results, include_answer }` → `{ answer?, results:[{title,url,content}] }`。
   - Brave：`GET https://api.search.brave.com/res/v1/web/search?q=&count=`，header `X-Subscription-Token` → `{ web:{ results:[{title,url,description}] } }`。
5. **settings**：`settingsSchema.ts` 的 `id:'web'` 分类目前有 FETCH_*/SUBAGENT_*/PI_BIN，**无搜索 key**。需加 `WEB_SEARCH_PROVIDER` / `TAVILY_API_KEY` / `BRAVE_API_KEY`。
6. **前端卡片**：`extensionCards.tsx` 的 `EXTENSION_CARDS` 映射 + `toolUtils.ts` 图标。仿 `FetchUrlCard` / `SpawnAgentCard`。
7. **输入快捷**：spec §9 提 `src/features/chat/input/config.tsx`（联网搜索快捷）—— 实现时先确认该文件结构，按现有快捷项同构添加（可选增强）。

---

## 方案与权衡

- **provider 抽象**：纯函数 `parseTavily(json)` / `parseBrave(json)` → 统一 `SearchResult[]`；`formatResults(query, results, answer?)` 输出 LLM 友好文本；`resolveProvider(env)` 选 provider + 取 key。这些纯函数可单测，不触网。
- **取正文策略**：MVP 默认**不**抓正文（只回摘要 + 链接，省时省 token）；工具参数 `fetchTop?: number` 可选对前 N 个结果用 web-fetch 的 `html.ts` 抓正文。Agent 想读全文可再调 `fetch_url`。
- **错误降级**：无 key → 返回提示「配置 TAVILY_API_KEY / 或用 fetch_url」；API 失败 → 报错文本，不抛崩。
- **零额外依赖**：用 Node `fetch`，复用 web-fetch 的 `html.ts`（通过相对 import 或复制最小子集；优先相对 import `../web-fetch/html.js`，若打包问题则在 `_shared` 放共享）。

---

## 文件结构

- 创建 `extensions/web-search/package.json` — `pi-web-search`（仿 web-fetch）
- 创建 `extensions/web-search/provider.ts` — 纯函数：`SearchResult` 类型、`parseTavily`、`parseBrave`、`formatResults`、`resolveProvider`
- 创建 `extensions/web-search/provider.test.ts` — 纯函数单测
- 创建 `extensions/web-search/index.ts` — `web_search` 工具（HTTP 调用 + 可选取正文）
- 修改 `extensions/index.ts` — 注册 `webSearch` 到 `allExtensions`（webFetch 之后）
- 修改 `tauri-agent/src/features/settings/settingsSchema.ts` — `web` 分类加 `WEB_SEARCH_PROVIDER`/`TAVILY_API_KEY`/`BRAVE_API_KEY`
- 修改 `tauri-agent/src/features/tools/extensionCards.tsx` — 加 `WebSearchCard` + 注册到 `EXTENSION_CARDS.web_search`
- 修改 `tauri-agent/src/features/tools/toolUtils.ts` — `web_search` 图标/标签
- （可选）修改 `tauri-agent/src/features/chat/input/config.tsx` — 「联网搜索」快捷
- 重建 sidecar + 端到端冒烟

---

## 任务 1：web-search 纯函数 + 单测

**文件：** `extensions/web-search/package.json`、`extensions/web-search/provider.ts`、`extensions/web-search/provider.test.ts`

- [ ] **步骤 1：package.json**（仿 web-fetch，name `pi-web-search`）
- [ ] **步骤 2：写失败测试** `provider.test.ts`：
  - `parseTavily({ answer, results:[{title,url,content}] })` → `{ answer, results:[{title,url,snippet}] }`
  - `parseBrave({ web:{ results:[{title,url,description}] } })` → `{ results:[{title,url,snippet}] }`
  - `formatResults("q", results, answer)` → 含 answer 段 + 每条 `- title` / `  url` / `  snippet`
  - `resolveProvider({})` → 默认 tavily；`resolveProvider({ WEB_SEARCH_PROVIDER:"brave", BRAVE_API_KEY:"k" })` → brave+key；无 key → error 标记
- [ ] **步骤 3：运行确认失败** — `cd extensions/web-search && & "../../tauri-agent/node_modules/.bin/vitest.CMD" run`
- [ ] **步骤 4：实现** `provider.ts`：

```ts
export interface SearchResult { title: string; url: string; snippet: string; }
export interface ParsedSearch { answer?: string; results: SearchResult[]; }
export type ProviderChoice =
  | { ok: true; provider: "tavily" | "brave"; apiKey: string }
  | { ok: false; reason: string };

export function resolveProvider(env: Record<string, string | undefined>): ProviderChoice {
  const provider = (env.WEB_SEARCH_PROVIDER ?? "tavily").toLowerCase() === "brave" ? "brave" : "tavily";
  const apiKey = provider === "brave" ? env.BRAVE_API_KEY : env.TAVILY_API_KEY;
  if (!apiKey) return { ok: false, reason: `缺少 ${provider === "brave" ? "BRAVE_API_KEY" : "TAVILY_API_KEY"}` };
  return { ok: true, provider, apiKey };
}

export function parseTavily(json: any): ParsedSearch {
  const results: SearchResult[] = (json?.results ?? []).map((r: any) => ({
    title: String(r?.title ?? ""), url: String(r?.url ?? ""), snippet: String(r?.content ?? ""),
  })).filter((r: SearchResult) => r.url);
  return { answer: typeof json?.answer === "string" ? json.answer : undefined, results };
}

export function parseBrave(json: any): ParsedSearch {
  const results: SearchResult[] = (json?.web?.results ?? []).map((r: any) => ({
    title: String(r?.title ?? ""), url: String(r?.url ?? ""), snippet: String(r?.description ?? ""),
  })).filter((r: SearchResult) => r.url);
  return { results };
}

export function formatResults(query: string, parsed: ParsedSearch): string {
  const lines: string[] = [];
  if (parsed.answer) lines.push(parsed.answer, "");
  lines.push(`搜索「${query}」结果：`);
  for (const r of parsed.results) {
    lines.push(`- ${r.title || r.url}`, `  ${r.url}`);
    if (r.snippet) lines.push(`  ${r.snippet}`);
  }
  if (parsed.results.length === 0) lines.push("（无结果）");
  return lines.join("\n");
}
```

> 注：parse 用 `any` 解析外部 JSON 后立即收敛为 `SearchResult`；如需更严可用 typebox 校验，MVP 用防御性读取。

- [ ] **步骤 5：运行确认通过**
- [ ] **步骤 6：Commit** — `feat(web-search): provider parse + result formatting pure functions (A4)`

---

## 任务 2：web-search 工具入口

**文件：** `extensions/web-search/index.ts`

- [ ] **步骤 1：实现** `web_search` 工具：
  - parameters：`query`（必），`maxResults?`（默认 5），`fetchTop?`（默认 0，>0 时用 html.ts 抓前 N 条正文附在末尾）
  - `resolveProvider(process.env)`；无 key → 返回提示文本（不抛）
  - Tavily：`fetch("https://api.tavily.com/search", { method:"POST", body: JSON.stringify({ api_key, query, max_results, include_answer:true }) })` → `parseTavily`
  - Brave：`fetch("https://api.search.brave.com/res/v1/web/search?q=...&count=...", { headers:{ "X-Subscription-Token": apiKey, accept:"application/json" } })` → `parseBrave`
  - 超时 `WEB_SEARCH_TIMEOUT_MS`（默认 15000），AbortController + signal
  - 返回 `{ content:[{type:"text", text: formatResults(...) + 可选正文}], details:{ provider, query, count, results } }`（details.results 供前端卡片）
- [ ] **步骤 2：Commit** — `feat(web-search): web_search tool (tavily/brave + optional body fetch) (A4)`

---

## 任务 3：注册并重建 sidecar

**文件：** `extensions/index.ts`

- [ ] **步骤 1：注册** `webSearch`（import 字母序；export 与 `allExtensions` 在 `webFetch` 之后追加）
- [ ] **步骤 2：重建** — `cd tauri-agent && node scripts/build-sidecar.mjs` → ready，无 `Could not resolve`
- [ ] **步骤 3：Commit** — `feat(web-search): register web-search extension into sidecar bundle (A4)`

---

## 任务 4：settings 加搜索 key

**文件：** `tauri-agent/src/features/settings/settingsSchema.ts`

- [ ] **步骤 1**：`id:'web'` 分类加：

```ts
{ key: 'WEB_SEARCH_PROVIDER', label: '搜索引擎（tavily/brave，默认 tavily）', type: 'text', placeholder: 'tavily' },
{ key: 'TAVILY_API_KEY', label: 'Tavily API Key', type: 'password', placeholder: 'tvly-...' },
{ key: 'BRAVE_API_KEY', label: 'Brave Search API Key', type: 'password' },
```

- [ ] **步骤 2**：前端 `tsc --noEmit` 0
- [ ] **步骤 3：Commit** — `feat(settings): web search provider + API keys (A4)`

---

## 任务 5：前端 WebSearchCard

**文件：** `tauri-agent/src/features/tools/extensionCards.tsx`、`tauri-agent/src/features/tools/toolUtils.ts`（+ 既有 `extensionCards.test.tsx` 补用例）

- [ ] **步骤 1：写失败测试**（仿现有卡片测试）：`web_search` 结果含 N 条链接渲染
- [ ] **步骤 2：实现** `WebSearchCard`（读 `details.results` 渲染 title+url 列表 + count；仿 `SpawnAgentCard`/`FetchUrlCard`），注册 `EXTENSION_CARDS.web_search`，`toolUtils` 加图标（如 `Search`/`Globe`）+ 中文标签
- [ ] **步骤 3：测试通过 + 前端 tsc 0**
- [ ] **步骤 4：Commit** — `feat(web-search): WebSearchCard result list in chat stream (A4)`

---

## 任务 6（可选）：输入区「联网搜索」快捷

**文件：** `tauri-agent/src/features/chat/input/config.tsx`

- [ ] **步骤 1**：先读该文件结构，确认快捷项模式后同构添加「联网搜索」入口（点按在输入前缀提示 agent 用 web_search，或插入 `/search` 提示）。若与现有交互不契合则**跳过**（留增强）。
- [ ] **步骤 2：Commit**（如实现）

---

## 任务 7：重建 + 端到端冒烟

- [ ] **步骤 1：重建** sidecar（若任务 3 后又改 extension 代码）
- [ ] **步骤 2：验证 web_search 路由**（无 key 路径）：直接跑 `<sidecar> --mode json -p --no-session "search the web for X"`，确认 agent 调 `web_search` 并优雅提示缺 key（或配置 key 后返回结果）。
- [ ] **步骤 3：app 内验证**（需 GUI + key）：触发搜索，`WebSearchCard` 渲染结果列表。

---

## 自检

**规格覆盖度（对照 spec §4.7）：**
- `web_search` 工具，provider Tavily 默认/Brave → 任务 1（resolveProvider）+ 任务 2 ✅
- env 配 API key → 任务 4 ✅
- 返回「摘要 + 结果链接」→ 任务 1（formatResults）✅
- 可选对 top 结果 fetch 正文 → 任务 2（`fetchTop` 参数）✅
- WebSearchCard 结果列表 → 任务 5 ✅
- 输入区「联网搜索」快捷 → 任务 6（可选）◐

**测试策略：** 纯函数（parse/format/resolve）单测覆盖；真实 API 调用需 key，靠端到端冒烟（任务 7）。

**风险：**
- Tavily/Brave 响应字段名以官方文档为准，实现任务 1 前用 context7/官方文档核对 `content` vs `description`、`answer` 字段。
- `html.ts` 复用：优先 `import from "../web-fetch/html.js"`；若 bun 打包跨目录 import 报错，则把所需函数移到 `extensions/_shared/`。
