// Direct HTTP fetch helpers (mcp-npx-fetch parity): raw HTML, markdown, plain text, JSON.
// Uses Pi's zero-dep html.ts converters instead of jsdom/turndown; SSRF guard is applied
// by callers before invoking these functions.

import { getConfig } from "../_shared/runtime-config.js";
import { htmlToMarkdown, htmlToText } from "./html.js";

export interface FetchRequest {
  url: string;
  headers?: Record<string, string>;
}

const defaultTimeoutMs = () => Number(getConfig("FETCH_TIMEOUT_MS") ?? "15000") || 15000;

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function withFetchTimeout<T>(
  request: FetchRequest,
  outerSignal: AbortSignal | undefined,
  readBody: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), defaultTimeoutMs());
  if (outerSignal) outerSignal.addEventListener("abort", () => controller.abort(), { once: true });

  try {
    const response = await fetch(request.url, {
      signal: controller.signal,
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        ...request.headers,
      },
    });
    if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
    return await readBody(response);
  } catch (e: unknown) {
    if (e instanceof Error) throw new Error(`Failed to fetch ${request.url}: ${e.message}`);
    throw new Error(`Failed to fetch ${request.url}: Unknown error`);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchHtml(request: FetchRequest, signal?: AbortSignal): Promise<string> {
  return withFetchTimeout(request, signal, (response) => response.text());
}

export async function fetchMarkdown(request: FetchRequest, signal?: AbortSignal): Promise<string> {
  const html = await fetchHtml(request, signal);
  return htmlToMarkdown(html);
}

export async function fetchTxt(request: FetchRequest, signal?: AbortSignal): Promise<string> {
  const html = await fetchHtml(request, signal);
  return htmlToText(html);
}

export async function fetchJson(request: FetchRequest, signal?: AbortSignal): Promise<string> {
  return withFetchTimeout(request, signal, async (response) => JSON.stringify(await response.json()));
}
