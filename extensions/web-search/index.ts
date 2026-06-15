// web-search: open-webSearch 能力内置版 — 多引擎 search + 站点/文章抓取工具。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isSafeUrl } from "../web-fetch/html.js";
import { getCrawler, type CrawlSuccessResult } from "../web-crawler/index.js";
import { fetchCsdnArticle } from "./fetch/csdn.js";
import { fetchGithubReadme, extractGithubRepo } from "./fetch/github.js";
import { fetchJuejinArticle } from "./fetch/juejin.js";
import { fetchLinuxDoArticle } from "./fetch/linuxdo.js";
import { fetchWebContent } from "./fetch/web.js";
import {
  filterResultsByHost,
  normalizeEngineName,
  parseBaidu,
  parseCsdn,
  parseEngineChain,
  parseExa,
  parseJuejin,
  runEngineChain,
  siteQuery,
  SUPPORTED_SEARCH_ENGINES,
  type BuiltinEngine,
} from "./engines/index.js";
import {
  formatResults,
  parseBing,
  parseBrave,
  parseDuckDuckGo,
  parseSogou,
  parseTavily,
  resolveProvider,
  type ParsedSearch,
  type SearchResult,
} from "./provider.js";
import { executeMultiEngineSearch, type SearchEngineExecutor } from "./searchService.js";
import { getConfig, getAllConfig } from "../_shared/runtime-config.js";

const TIMEOUT_MS = Number(process.env.WEB_SEARCH_TIMEOUT_MS ?? "15000") || 15000;
const FETCH_BODY_MAX = 4000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  outer: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (outer) outer.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function tavilySearch(apiKey: string, query: string, maxResults: number, signal: AbortSignal | undefined) {
  const res = await fetchWithTimeout(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults, include_answer: true }),
    },
    signal,
    TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json() as Promise<unknown>;
}

async function braveSearch(apiKey: string, query: string, maxResults: number, signal: AbortSignal | undefined) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
  const res = await fetchWithTimeout(
    url,
    { headers: { "X-Subscription-Token": apiKey, accept: "application/json", "accept-encoding": "gzip" } },
    signal,
    TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json() as Promise<unknown>;
}

async function duckduckgoSearch(query: string, maxResults: number, signal: AbortSignal | undefined): Promise<ParsedSearch> {
  const res = await fetchWithTimeout(
    "https://html.duckduckgo.com/html/",
    {
      method: "POST",
      headers: { accept: "text/html", "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
      body: `q=${encodeURIComponent(query)}`,
    },
    signal,
    TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return { results: parseDuckDuckGo(await res.text()).results.slice(0, maxResults) };
}

async function bingSearch(query: string, maxResults: number, signal: AbortSignal | undefined): Promise<ParsedSearch> {
  const res = await fetchWithTimeout(
    `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`,
    { headers: { "accept-language": "zh-CN,zh;q=0.9,en;q=0.8", "user-agent": UA } },
    signal,
    TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return { results: parseBing(await res.text()).results.slice(0, maxResults) };
}

async function sogouSearch(query: string, maxResults: number, signal: AbortSignal | undefined): Promise<ParsedSearch> {
  const res = await fetchWithTimeout(
    `https://www.sogou.com/web?query=${encodeURIComponent(query)}`,
    { headers: { "accept-language": "zh-CN,zh;q=0.9,en;q=0.8", "user-agent": UA } },
    signal,
    TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return { results: parseSogou(await res.text()).results.slice(0, maxResults) };
}

async function baiduSearch(query: string, maxResults: number, signal: AbortSignal | undefined): Promise<ParsedSearch> {
  const params = new URLSearchParams({ wd: query, pn: "0", ie: "utf-8", tn: "88093251_62_hao_pg" });
  const res = await fetchWithTimeout(`https://www.baidu.com/s?${params}`, {
    headers: { "accept-language": "zh-CN,zh;q=0.9", "user-agent": UA },
  }, signal, TIMEOUT_MS);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return { results: parseBaidu(await res.text()).slice(0, maxResults) };
}

async function csdnSearch(query: string, maxResults: number, signal: AbortSignal | undefined): Promise<ParsedSearch> {
  const res = await fetchWithTimeout(
    `https://so.csdn.net/api/v3/search?q=${encodeURIComponent(query)}&p=1&t=all`,
    { headers: { accept: "application/json", "user-agent": UA } },
    signal,
    TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return { results: parseCsdn(await res.json()).slice(0, maxResults) };
}

async function juejinSearch(query: string, maxResults: number, signal: AbortSignal | undefined): Promise<ParsedSearch> {
  const params = new URLSearchParams({
    aid: "2608",
    spider: "0",
    query,
    id_type: "0",
    cursor: "0",
    limit: String(Math.min(20, maxResults)),
    search_type: "0",
    sort_type: "0",
    version: "1",
  });
  const res = await fetchWithTimeout(`https://api.juejin.cn/search_api/v1/search?${params}`, {
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": UA },
  }, signal, TIMEOUT_MS);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return { results: parseJuejin(await res.json()).slice(0, maxResults) };
}

async function exaSearch(query: string, maxResults: number, signal: AbortSignal | undefined): Promise<ParsedSearch> {
  const res = await fetchWithTimeout(
    "https://exa.ai/search/api/search-fast",
    {
      method: "POST",
      headers: {
        accept: "*/*",
        "content-type": "text/plain;charset=UTF-8",
        origin: "https://exa.ai",
        "user-agent": UA,
      },
      body: JSON.stringify({
        numResults: maxResults,
        query,
        type: "auto",
        useAutoprompt: true,
        text: true,
        density: "compact",
        resolvedSearchType: "neural",
        moderation: true,
        fastMode: false,
      }),
    },
    signal,
    TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return { results: parseExa(await res.json()).slice(0, maxResults) };
}

async function zhihuSearch(query: string, maxResults: number, signal: AbortSignal | undefined): Promise<ParsedSearch> {
  const parsed = await bingSearch(siteQuery("zhuanlan.zhihu.com", query), maxResults, signal);
  return {
    results: filterResultsByHost(parsed.results, (h) => h === "zhuanlan.zhihu.com").slice(0, maxResults),
  };
}

async function linuxdoSearch(query: string, maxResults: number, signal: AbortSignal | undefined): Promise<ParsedSearch> {
  const parsed = await bingSearch(siteQuery("linux.do", query), maxResults, signal);
  return { results: filterResultsByHost(parsed.results, (h) => h === "linux.do" || h.endsWith(".linux.do")).slice(0, maxResults) };
}

async function runBuiltinEngine(
  engine: BuiltinEngine,
  query: string,
  maxResults: number,
  signal: AbortSignal | undefined,
): Promise<ParsedSearch> {
  if (engine === "bing") return bingSearch(query, maxResults, signal);
  if (engine === "sogou") return sogouSearch(query, maxResults, signal);
  if (engine === "duckduckgo") return duckduckgoSearch(query, maxResults, signal);
  if (engine === "baidu") return baiduSearch(query, maxResults, signal);
  if (engine === "csdn") return csdnSearch(query, maxResults, signal);
  if (engine === "juejin") return juejinSearch(query, maxResults, signal);
  if (engine === "exa") return exaSearch(query, maxResults, signal);
  if (engine === "zhihu") return zhihuSearch(query, maxResults, signal);
  return linuxdoSearch(query, maxResults, signal);
}

function defaultEngineChain(provider: BuiltinEngine): BuiltinEngine[] {
  if (provider === "bing") return ["bing", "sogou", "baidu"];
  if (provider === "sogou") return ["sogou", "baidu"];
  return [provider];
}

function buildEngineExecutors(signal: AbortSignal | undefined): Record<string, SearchEngineExecutor> {
  return Object.fromEntries(
    SUPPORTED_SEARCH_ENGINES.map((engine) => [
      engine,
      async (query, limit, sig) => (await runBuiltinEngine(engine, query, limit, sig ?? signal)).results,
    ]),
  );
}

function resolveSearchEngines(raw: string[] | undefined, fallback: BuiltinEngine[]): BuiltinEngine[] {
  if (!raw?.length) return fallback;
  const out: BuiltinEngine[] = [];
  for (const item of raw) {
    const name = normalizeEngineName(item);
    if (name && !out.includes(name)) out.push(name);
  }
  return out.length > 0 ? out : fallback;
}

async function fetchBodies(results: SearchResult[], signal: AbortSignal | undefined): Promise<string> {
  const parts: string[] = [];
  const crawler = getCrawler();
  for (const r of results) {
    if (!isSafeUrl(r.url).ok) continue;
    const res = await crawler.crawl({ url: r.url, signal: signal ?? undefined });
    if (!("contentType" in res.data)) continue;
    let md = (res.data as CrawlSuccessResult).content ?? "";
    if (!md) continue;
    if (md.length > FETCH_BODY_MAX) md = `${md.slice(0, FETCH_BODY_MAX)}…`;
    parts.push(`## ${r.title || r.url}\n${r.url}\n\n${md}`);
  }
  return parts.join("\n\n---\n\n");
}

function searchDetails(query: string, provider: string, parsed: ParsedSearch, engines?: string[]) {
  return {
    query,
    provider,
    engines,
    count: parsed.results.length,
    results: parsed.results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web with zero-config fallback (Bing → Sogou → Baidu). Use search for multi-engine control, or fetch_* tools for full article bodies.",
    promptSnippet: "Search the web; returns summary + result links.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      maxResults: Type.Optional(Type.Number({ description: "Max results (default 5, max 10)" })),
      fetchTop: Type.Optional(Type.Number({ description: "Also fetch the body of the top N results as markdown (default 0, max 3)" })),
    }),
    async execute(_toolCallId, params, signal) {
      const choice = resolveProvider(getAllConfig());
      if (!choice.ok) {
        return {
          content: [{ type: "text", text: `web_search 不可用：${choice.reason}` }],
          details: { error: choice.reason },
        };
      }

      const query = params.query.trim();
      const maxResults = Math.max(1, Math.min(params.maxResults ?? 5, 10));
      let parsed: ParsedSearch;
      let usedEngine = choice.provider;
      try {
        if (choice.provider === "brave") {
          parsed = parseBrave(await braveSearch(choice.apiKey, query, maxResults, signal ?? undefined));
        } else if (choice.provider === "tavily") {
          parsed = parseTavily(await tavilySearch(choice.apiKey, query, maxResults, signal ?? undefined));
        } else {
          const explicitChain = parseEngineChain(getConfig("WEB_SEARCH_ENGINES"));
          const chain = explicitChain.length > 0 ? explicitChain : defaultEngineChain(choice.provider as BuiltinEngine);
          const out = await runEngineChain(chain, query, maxResults, signal ?? undefined, (engine) =>
            runBuiltinEngine(engine, query, maxResults, signal ?? undefined),
          );
          parsed = out.parsed;
          if (out.engine !== "none") usedEngine = out.engine;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `web_search 失败（${usedEngine}）：${msg}` }],
          details: { provider: usedEngine, query, error: msg },
        };
      }

      let text = formatResults(query, parsed);
      const fetchTop = Math.max(0, Math.min(params.fetchTop ?? 0, 3));
      if (fetchTop > 0 && parsed.results.length > 0) {
        const bodies = await fetchBodies(parsed.results.slice(0, fetchTop), signal ?? undefined);
        if (bodies) text += `\n\n---\n\n${bodies}`;
      }

      return {
        content: [{ type: "text", text }],
        details: searchDetails(query, usedEngine, parsed),
      };
    },
  });

  // open-webSearch 同名多引擎 search 工具
  pi.registerTool({
    name: "search",
    label: "Multi-Engine Search",
    description:
      "Search the web using one or more built-in engines (bing, baidu, sogou, csdn, juejin, exa, linuxdo, duckduckgo). No API key required.",
    promptSnippet: "Multi-engine web search (open-webSearch compatible).",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Max total results (default 10, max 50)" })),
      engines: Type.Optional(
        Type.Array(Type.String(), {
          description: `Engines to use (default: bing,baidu). Supported: ${SUPPORTED_SEARCH_ENGINES.join(", ")}`,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const query = params.query.trim();
      const limit = Math.max(1, Math.min(params.limit ?? 10, 50));
      const engines = resolveSearchEngines(params.engines, ["bing", "baidu"]);
      const out = await executeMultiEngineSearch(
        query,
        engines,
        limit,
        signal ?? undefined,
        buildEngineExecutors(signal ?? undefined),
      );
      const text = formatResults(query, { results: out.results });
      return {
        content: [{ type: "text", text }],
        details: {
          query,
          provider: "multi",
          engines: out.engines,
          count: out.results.length,
          partialFailures: out.partialFailures,
          results: out.results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
        },
      };
    },
  });

  const articleTool = (
    name: string,
    label: string,
    description: string,
    validate: (url: string) => boolean,
    fetcher: (url: string, signal: AbortSignal | undefined) => Promise<string>,
  ) => {
    pi.registerTool({
      name,
      label,
      description,
      promptSnippet: description,
      parameters: Type.Object({ url: Type.String({ description: "Article URL" }) }),
      async execute(_toolCallId, params, signal) {
        const url = params.url.trim();
        if (!isSafeUrl(url).ok || !validate(url)) {
          return {
            content: [{ type: "text", text: `${name}：URL 无效或不支持` }],
            details: { url, error: "invalid_url" },
          };
        }
        try {
          const content = await fetcher(url, signal ?? undefined);
          return {
            content: [{ type: "text", text: content }],
            details: { url, chars: content.length },
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `${name} 失败：${msg}` }],
            details: { url, error: msg },
          };
        }
      },
    });
  };

  articleTool(
    "fetch_csdn_article",
    "Fetch CSDN Article",
    "Fetch full article content from a CSDN blog post URL",
    (url) => /blog\.csdn\.net/.test(url) && /\/article\/details\//.test(url),
    (url, signal) => fetchCsdnArticle(url, signal, TIMEOUT_MS),
  );

  articleTool(
    "fetch_juejin_article",
    "Fetch Juejin Article",
    "Fetch full article content from a Juejin post URL",
    (url) => /juejin\.cn\/post\//.test(url),
    (url, signal) => fetchJuejinArticle(url, signal, TIMEOUT_MS),
  );

  articleTool(
    "fetch_linuxdo_article",
    "Fetch Linux.do Article",
    "Fetch full article content from a linux.do topic URL",
    (url) => /linux\.do\/t\//.test(url),
    (url, signal) => fetchLinuxDoArticle(url, signal, TIMEOUT_MS),
  );

  pi.registerTool({
    name: "fetch_github_readme",
    label: "Fetch GitHub README",
    description: "Fetch README content from a GitHub repository URL",
    promptSnippet: "Fetch GitHub repo README.",
    parameters: Type.Object({ url: Type.String({ description: "GitHub repository URL" }) }),
    async execute(_toolCallId, params, signal) {
      const url = params.url.trim();
      if (!extractGithubRepo(url)) {
        return {
          content: [{ type: "text", text: "fetch_github_readme：无效的 GitHub 仓库 URL" }],
          details: { url, error: "invalid_url" },
        };
      }
      const content = await fetchGithubReadme(url, signal ?? undefined, TIMEOUT_MS);
      if (!content) {
        return {
          content: [{ type: "text", text: "README not found or repository does not exist" }],
          details: { url, error: "not_found" },
        };
      }
      return {
        content: [{ type: "text", text: content }],
        details: { url, chars: content.length },
      };
    },
  });

  pi.registerTool({
    name: "fetch_web_content",
    label: "Fetch Web Content",
    description: "Fetch readable text content from a public HTTP(S) URL (open-webSearch compatible).",
    promptSnippet: "Fetch readable web page text.",
    parameters: Type.Object({
      url: Type.String({ description: "Public HTTP(S) URL" }),
      maxChars: Type.Optional(Type.Number({ description: "Max characters (default 30000, max 200000)" })),
    }),
    async execute(_toolCallId, params, signal) {
      const url = params.url.trim();
      const safe = isSafeUrl(url);
      if (!safe.ok) {
        return {
          content: [{ type: "text", text: `fetch_web_content：${safe.reason}` }],
          details: { url, error: safe.reason },
        };
      }
      const maxChars = Math.max(1000, Math.min(params.maxChars ?? 30000, 200000));
      try {
        const out = await fetchWebContent(url, maxChars, signal ?? undefined, TIMEOUT_MS);
        return {
          content: [{ type: "text", text: out.content }],
          details: { url, title: out.title, chars: out.content.length, truncated: out.truncated },
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `fetch_web_content 失败：${msg}` }],
          details: { url, error: msg },
        };
      }
    },
  });
}
