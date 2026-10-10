import type { ParsedSearch } from "../provider.js";

export type BuiltinEngine = "devin" | "bing" | "sogou" | "duckduckgo" | "baidu" | "csdn" | "juejin" | "exa" | "linuxdo" | "zhihu";

export const SUPPORTED_SEARCH_ENGINES: BuiltinEngine[] = [
  "devin",
  "bing",
  "sogou",
  "duckduckgo",
  "baidu",
  "csdn",
  "juejin",
  "exa",
  "linuxdo",
  "zhihu",
];

const ENGINE_SET = new Set<string>(SUPPORTED_SEARCH_ENGINES);

export function normalizeEngineName(engine: string): BuiltinEngine | null {
  const cleaned = engine.trim().toLowerCase().replace(/[\s._-]+/g, "");
  if (cleaned === "ddg" || cleaned === "duckduckgo") return "duckduckgo";
  if (cleaned === "sougou" || cleaned === "搜狗") return "sogou";
  if (cleaned === "zhihu" || cleaned === "知乎") return "zhihu";
  if (isBuiltinEngine(cleaned)) return cleaned;
  return null;
}

export function isBuiltinEngine(name: string): name is BuiltinEngine {
  return ENGINE_SET.has(name);
}

export function parseEngineChain(raw: string | undefined): BuiltinEngine[] {
  if (!raw?.trim()) return [];
  const out: BuiltinEngine[] = [];
  for (const part of raw.split(",")) {
    const name = normalizeEngineName(part);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Explicit engine list wins. Otherwise Devin leads when a session is ready, or when the user asked for Devin. */
export function resolveWebSearchChain(
  explicit: BuiltinEngine[],
  provider: BuiltinEngine,
  devinReady: boolean,
): BuiltinEngine[] {
  if (explicit.length > 0) return explicit;
  return defaultSearchChain(provider, devinReady);
}

export function defaultSearchChain(provider: BuiltinEngine, devinReady: boolean): BuiltinEngine[] {
  if (provider === "devin") return ["devin", "bing", "sogou", "baidu"];
  if (provider === "bing") return devinReady ? ["devin", "bing", "sogou", "baidu"] : ["bing", "sogou", "baidu"];
  if (provider === "sogou") return ["sogou", "baidu"];
  return [provider];
}

export async function runEngineChain(
  engines: BuiltinEngine[],
  query: string,
  maxResults: number,
  signal: AbortSignal | undefined,
  runBuiltin: (engine: BuiltinEngine) => Promise<ParsedSearch>,
): Promise<{ parsed: ParsedSearch; engine: BuiltinEngine | "none" }> {
  for (const engine of engines) {
    try {
      const parsed = await runBuiltin(engine);
      if (parsed.results.length > 0) return { parsed, engine };
    } catch {
      // try next engine in chain
    }
  }
  return { parsed: { results: [] }, engine: "none" };
}

export { parseBaidu } from "./baidu.js";
export { parseCsdn } from "./csdn.js";
export { parseJuejin } from "./juejin.js";
export { parseExa } from "./exa.js";
export { filterResultsByHost, siteQuery } from "./site.js";
