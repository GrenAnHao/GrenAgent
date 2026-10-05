// web-fetch: let the agent fetch web pages over http(s) and read them as
// markdown. Uses the shared multi-provider crawler (naive + Jina Reader, plus
// Firecrawl/Exa/Search1API when their API keys are set) with per-site URL rules,
// so JS-heavy or bot-protected pages still come back as clean content.

import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isSafeUrl } from "./html.js";
import { fetchHtml, fetchJson, fetchTxt } from "./fetcher.js";
import { getCrawler, type CrawlSuccessResult } from "../web-crawler/index.js";
import { headTailSlice, isUsableLlmsBody, resolveFetchMaxChars } from "./truncate.js";
import { getConfig } from "../_shared/runtime-config.js";

// Default FETCH_MAX_CHARS is the DSH read budget. Set 0 to disable truncation.
// When capped we keep a head+tail preview and spill the FULL page to
// <cwd>/.pi/web-fetch/<id>.md so the model can read the omitted middle on demand.
const maxChars = () => resolveFetchMaxChars(getConfig("FETCH_MAX_CHARS"));

// Spilled full-content files older than this are pruned on the next fetch.
const SPILL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function pruneSpillDir(dir: string): void {
  try {
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      try {
        if (now - statSync(join(dir, name)).mtimeMs > SPILL_RETENTION_MS) unlinkSync(join(dir, name));
      } catch {
        /* file vanished or locked; ignore */
      }
    }
  } catch {
    /* dir missing; ignore */
  }
}

// Write the full page to <cwd>/.pi/web-fetch/<id>.md and return the path. Best-effort:
// the caller treats a throw as "no spill" and degrades to panel-only full content.
function spillFullContent(cwd: string, url: string, full: string): string {
  const dir = join(cwd, ".pi", "web-fetch");
  mkdirSync(dir, { recursive: true });
  pruneSpillDir(dir);
  const file = join(dir, `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.md`);
  writeFileSync(file, `<!-- source: ${url} -->\n<!-- fetched: ${new Date().toISOString()} -->\n\n${full}`, "utf8");
  return file;
}

type ToolResult = { content: { type: "text"; text: string }[]; details: Record<string, unknown> };

// Assemble a tool result, applying the head+tail preview + disk-spill policy when the
// page exceeds FETCH_MAX_CHARS. Shared by every fetch_url format.
function buildResult(full: string, sourceUrl: string, baseDetails: Record<string, unknown>, cwd: string): ToolResult {
  const maxCharsVal = maxChars();
  const truncated = maxCharsVal > 0 && full.length > maxCharsVal;
  if (!truncated) {
    return { content: [{ type: "text", text: full }], details: { ...baseDetails, chars: full.length, truncated: false } };
  }
  let savedPath = "";
  try {
    savedPath = spillFullContent(cwd, sourceUrl, full);
  } catch {
    /* spill is best-effort; fall back to panel-only full content */
  }
  const { head, tail, omitted } = headTailSlice(full, maxCharsVal);
  const note = savedPath
    ? `\n\n...[${omitted} chars omitted — full ${full.length} chars saved to ${savedPath}; use the read tool (with offset/limit) or grep on that path for the rest]...\n\n`
    : `\n\n...[${omitted} chars omitted of ${full.length} total; full content shown in the right-hand panel]...\n\n`;
  return {
    content: [{ type: "text", text: head + note + tail }],
    details: { ...baseDetails, chars: full.length, truncated: true, omitted, savedPath: savedPath || undefined },
  };
}

const llmsTimeoutMs = () => Number(getConfig("FETCH_TIMEOUT_MS") ?? "15000") || 15000;

const FETCH_FORMATS = ["markdown", "text", "html", "json", "llms"] as const;
type FetchFormat = (typeof FETCH_FORMATS)[number];

function parseFormat(value: unknown): FetchFormat {
  if (value === undefined || value === "") return "markdown";
  if (typeof value === "string" && (FETCH_FORMATS as readonly string[]).includes(value)) return value as FetchFormat;
  throw new Error(`Unsupported format: ${String(value)}. Use markdown, text, html, json, or llms.`);
}

// Direct (non-crawler) probe for a site's llms.txt-style file. Returns the raw text,
// or null when missing / not actually a text index (e.g. a soft-404 HTML page).
async function probeLlms(url: string, signal: AbortSignal | undefined): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), llmsTimeoutMs());
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "text/markdown, text/plain;q=0.9, */*;q=0.1", "User-Agent": "pi-web-fetch/llms" },
    });
    if (!res.ok) return null;
    const body = await res.text();
    return isUsableLlmsBody(res.headers.get("content-type") ?? "", body) ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchViaCrawler(url: string, signal: AbortSignal | undefined, cwd: string): Promise<ToolResult> {
  const result = await getCrawler().crawl({ url, signal });
  const data = result.data;

  // All crawl providers failed → surface the error but don't throw.
  if (!("contentType" in data)) {
    return {
      content: [{ type: "text", text: data.content }],
      details: { url, format: "markdown", crawler: result.crawler, error: data.errorMessage },
    };
  }

  const page = data as CrawlSuccessResult;
  const full = (page.title ? `# ${page.title}\n\n` : "") + (page.content ?? "");
  return buildResult(
    full,
    page.url,
    {
      url: page.url,
      format: "markdown",
      title: page.title,
      crawler: result.crawler,
      transformedUrl: result.transformedUrl,
      contentType: page.contentType,
    },
    cwd,
  );
}

async function fetchLlms(url: string, full: boolean, signal: AbortSignal | undefined, cwd: string): Promise<ToolResult> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  const candidates = full
    ? [`${origin}/llms-full.txt`, `${origin}/llms.txt`]
    : [`${origin}/llms.txt`, `${origin}/llms-full.txt`];

  for (const candidate of candidates) {
    if (!isSafeUrl(candidate).ok) continue;
    const body = await probeLlms(candidate, signal);
    if (!body) continue;
    const kind = candidate.endsWith("llms-full.txt") ? "llms-full" : "llms";
    return buildResult(`# ${candidate}\n\n${body}`, candidate, { url: candidate, origin, format: "llms", kind }, cwd);
  }

  return {
    content: [
      {
        type: "text",
        text: `No llms.txt or llms-full.txt found at ${origin}. Call fetch_url again without format=llms for the specific page.`,
      },
    ],
    details: { origin, format: "llms", found: false },
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "fetch_url",
    label: "Fetch URL",
    description:
      "Fetch one http(s) URL. format selects the result: " +
      "markdown (default) returns main content via crawl providers (naive, Jina Reader, and Firecrawl/Exa/Search1API when keyed), " +
      "so JS-heavy or bot-protected pages stay readable; " +
      "text is a direct request with tags, scripts, and styles removed; " +
      "html is the raw response; " +
      "json is parsed JSON as text; " +
      "llms probes <origin>/llms.txt (full=true prefers llms-full.txt). " +
      "headers apply only to text, html, and json.",
    promptSnippet: "Fetch an http(s) page as markdown, text, HTML, JSON, or a site llms.txt index.",
    promptGuidelines: [
      "Use fetch_url to read an http(s) page. Leave format as markdown for ordinary pages. On documentation sites, call fetch_url with format=llms first.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "Absolute http(s) URL" }),
      format: Type.Optional(
        Type.Union(
          [
            Type.Literal("markdown"),
            Type.Literal("text"),
            Type.Literal("html"),
            Type.Literal("json"),
            Type.Literal("llms"),
          ],
          { description: "Result form. Default markdown uses the crawler. text, html, and json are direct HTTP. llms probes the site index." },
        ),
      ),
      full: Type.Optional(
        Type.Boolean({ description: "When format is llms, prefer llms-full.txt over llms.txt." }),
      ),
      headers: Type.Optional(
        Type.Unsafe<Record<string, string>>({
          type: "object",
          additionalProperties: { type: "string" },
          description: "Optional HTTP headers for format text, html, or json",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const safe = isSafeUrl(params.url);
      if (!safe.ok) throw new Error(`Refused to fetch: ${safe.reason}`);
      const format = parseFormat(params.format);
      const abort = signal ?? undefined;
      if (format === "llms") return fetchLlms(params.url, params.full === true, abort, ctx.cwd);
      if (format === "markdown") return fetchViaCrawler(params.url, abort, ctx.cwd);

      const request = { url: params.url, headers: params.headers };
      const body =
        format === "html"
          ? await fetchHtml(request, abort)
          : format === "json"
            ? await fetchJson(request, abort)
            : await fetchTxt(request, abort);
      return buildResult(body, params.url, { url: params.url, format }, ctx.cwd);
    },
  });
}
