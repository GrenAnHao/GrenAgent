// web-search: 联网搜索（web_search）与 AnySearch（anysearch_search / anysearch_sub_domains）。
// 单页抓取走 web-fetch 的 fetch_url，这里不再注册站点专用抓取。

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  resolveWebSearchChain,
  parseBaidu,
  parseEngineChain,
  runEngineChain,
  type BuiltinEngine,
} from "./engines/index.js";
import { toolPrompt } from "../_shared/toolPrompt.js";
import { registerAnySearchTools } from "./anysearch.js";
import {
  clampWebSearchLimit,
  formatResults,
  parseBing,
  parseDuckDuckGo,
  parseSogou,
  retainSearchResults,
  resolveProvider,
  type ParsedSearch,
} from "./provider.js";
import { getConfig, getAllConfig } from "../_shared/runtime-config.js";
import { authorizeDesktopOperation, desktopControl, type DesktopControlPort } from "../_shared/desktop-control.js";
import { currentCwd } from "../_shared/workspace-context.js";

function toolCwd(ctx: { cwd?: unknown } | undefined): string {
  return typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : currentCwd();
}

const TIMEOUT_MS = Number(process.env.WEB_SEARCH_TIMEOUT_MS ?? "15000") || 15000;

export const pluginManifest = {
  id: "web-search",
  version: "0.1.0",
  apiVersion: "1",
  capabilities: ["tool"],
  permissions: { network: "full" },
} as const;
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

async function runBuiltinEngine(
  engine: BuiltinEngine,
  query: string,
  maxResults: number,
  signal: AbortSignal | undefined,
): Promise<ParsedSearch> {
  if (engine === "bing") return bingSearch(query, maxResults, signal);
  if (engine === "sogou") return sogouSearch(query, maxResults, signal);
  if (engine === "duckduckgo") return duckduckgoSearch(query, maxResults, signal);
  return baiduSearch(query, maxResults, signal);
}

function searchDetails(query: string, provider: string, parsed: ParsedSearch, engines?: string[]) {
  const { results } = retainSearchResults(parsed.results);
  return {
    query,
    provider,
    engines,
    count: results.length,
    results: results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
  };
}

export default function (pi: ExtensionAPI, control: DesktopControlPort = desktopControl()) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web with zero-config fallback (Bing → Sogou → Baidu). Use fetch_url for full article bodies. For one site, put a `site:` operator in the query.",
    promptSnippet: "Search the web; returns result links.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      maxResults: Type.Optional(Type.Number({ description: "Max sources (default 8, hard cap 8)" })),
    }),
    async execute(_toolCallId, params, signal, _update, ctx): Promise<AgentToolResult<Record<string, unknown>>> {
      const denied = await requireNetwork(control, 'web_search', toolCwd(ctx));
      if (denied) return denied;
      const choice = resolveProvider(getAllConfig());
      if (!choice.ok) {
        return {
          content: [{ type: "text", text: `web_search 不可用：${choice.reason}` }],
          details: { error: choice.reason },
        };
      }

      const query = params.query.trim();
      const maxResults = clampWebSearchLimit(params.maxResults);
      let parsed: ParsedSearch;
      let usedEngine: string = choice.provider;
      try {
        const explicitChain = parseEngineChain(getConfig("WEB_SEARCH_ENGINES"));
        const chain = resolveWebSearchChain(explicitChain, choice.provider);
        const out = await runEngineChain(chain, query, maxResults, signal ?? undefined, (engine) =>
          runBuiltinEngine(engine, query, maxResults, signal ?? undefined),
        );
        parsed = out.parsed;
        if (out.engine !== "none") usedEngine = out.engine;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `web_search 失败（${usedEngine}）：${msg}` }],
          details: { provider: usedEngine, query, error: msg },
        };
      }

      return {
        content: [{ type: "text", text: formatResults(query, parsed) }],
        details: searchDetails(query, usedEngine, parsed),
      };
    },
  });

  registerAnySearchTools(pi, (toolName, ctx) => requireNetwork(control, toolName, toolCwd(ctx)));
}

async function requireNetwork(
  control: DesktopControlPort,
  toolName: string,
  cwd: string,
): Promise<AgentToolResult<Record<string, unknown>> | undefined> {
  const authorization = await authorizeDesktopOperation(control, {
    kind: 'network.request',
    workspace: cwd,
    toolName,
  });
  if (authorization.status === 'allowed') return undefined;
  return {
    content: [{ type: 'text', text: `网络访问已被 Electron 权限策略${authorization.status === 'blocked' ? '暂停，等待批准' : '拒绝'}` }],
    details: { error: `network_${authorization.status}` },
  };
}
