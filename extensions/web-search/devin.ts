import { isAbsolute, join, resolve } from "node:path";
import { codeSearch, type SearchResult as DevinCodeHit } from "../devin-client/code-search.js";
import { contains } from "../devin-client/local.js";
import { WindsurfCompletion } from "../devin-client/completion.js";
import { Sessions } from "../devin-client/session.js";
import { webSearch } from "../devin-client/web.js";
import type { SearchResult } from "./provider.js";

export function mapDevinWebSources(
  sources: readonly { title: string; url: string; snippet: string }[],
): SearchResult[] {
  return sources
    .filter((source) => source.url.length > 0)
    .map((source) => ({ title: source.title, url: source.url, snippet: source.snippet }));
}

export async function devinSessionReady(): Promise<boolean> {
  const sessions = new Sessions();
  try {
    await sessions.reload();
    return sessions.available();
  } catch {
    return false;
  } finally {
    sessions.dispose();
  }
}

export async function runDevinWebSearch(
  query: string,
  maxResults: number,
  signal: AbortSignal | undefined,
): Promise<SearchResult[]> {
  const sessions = new Sessions();
  try {
    const out = await webSearch(sessions, query, maxResults, signal);
    return mapDevinWebSources(out.sources);
  } finally {
    sessions.dispose();
  }
}

/** Absolute folder inside cwd. Rejects paths that leave the workspace before any cloud call. */
export function codeSearchFolder(cwd: string, raw: string | undefined): string {
  if (!isAbsolute(cwd)) throw new Error("devin_code_search requires an absolute workspace.");
  const requested = raw?.trim() ? raw.trim() : ".";
  const folder = resolve(isAbsolute(requested) ? requested : join(cwd, requested));
  if (!contains(resolve(cwd), folder)) {
    throw new Error("devin_code_search path must stay inside the workspace.");
  }
  return folder;
}

const LOGIN_HINT = "Devin 未登录或登录已失效。请到设置的「网页 / 搜索」重新登录。登录不会自动刷新。";

export function devinUserMessage(text: string): string {
  if (/devin-search auth|session missing|session rejected|session expired|not logged in/i.test(text)) return LOGIN_HINT;
  return text;
}

export async function runDevinCodeSearch(
  query: string,
  cwd: string,
  folder: string,
  signal: AbortSignal,
): Promise<{ status: "success" | "error"; content: string; files: DevinCodeHit["files"] }> {
  const sessions = new Sessions();
  try {
    return await codeSearch(
      { search_term: query, search_folder_absolute_uri: folder },
      cwd,
      (path) => path,
      new WindsurfCompletion(sessions),
      signal,
    );
  } finally {
    sessions.dispose();
  }
}
