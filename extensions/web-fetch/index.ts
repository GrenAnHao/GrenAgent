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
import { getCrawler, type CrawlSuccessResult } from "../web-crawler/index.js";
import { headTailSlice, isUsableLlmsBody } from "./truncate.js";
import { getConfig } from "../_shared/runtime-config.js";

// 0 / unset = no truncation: return the full crawled content. Set FETCH_MAX_CHARS>0
// to cap how much enters the model context — when capped we keep a head+tail preview
// and spill the FULL page to <cwd>/.pi/web-fetch/<id>.md, so the model can read the
// omitted middle back on demand (read/grep) instead of losing it.
const maxChars = () => Number(getConfig("FETCH_MAX_CHARS") ?? "0") || 0;

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
// page exceeds FETCH_MAX_CHARS. Shared by fetch_url and fetch_llms.
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

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "fetch_url",
    label: "Fetch URL",
    description:
      "Fetch a web page over http(s) and return its main content as markdown. " +
      "Tries multiple crawl providers (naive, Jina Reader, and optionally Firecrawl/Exa/Search1API) " +
      "with per-site rules, so JS-heavy or bot-protected pages still come back readable. " +
      "Use it to read documentation, articles, API references, or release notes.",
    promptSnippet: "Fetch and read a web page (http/https) as markdown.",
    parameters: Type.Object({
      url: Type.String({ description: "Absolute http(s) URL" }),
      format: Type.Optional(Type.String({ description: "'markdown' (default) or 'text' (best-effort)" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const safe = isSafeUrl(params.url);
      if (!safe.ok) throw new Error(`Refused to fetch: ${safe.reason}`);

      const result = await getCrawler().crawl({ url: params.url, signal: signal ?? undefined });
      const data = result.data;

      // All crawl providers failed → surface the error but don't throw.
      if (!("contentType" in data)) {
        return {
          content: [{ type: "text", text: data.content }],
          details: { url: params.url, crawler: result.crawler, error: data.errorMessage },
        };
      }

      const page = data as CrawlSuccessResult;
      const full = (page.title ? `# ${page.title}\n\n` : "") + (page.content ?? "");
      return buildResult(
        full,
        page.url,
        {
          url: page.url,
          title: page.title,
          crawler: result.crawler,
          transformedUrl: result.transformedUrl,
          contentType: page.contentType,
        },
        ctx.cwd,
      );
    },
  });

  pi.registerTool({
    name: "fetch_llms",
    label: "Fetch llms.txt",
    description:
      "Discover a site's AI-friendly content index. Given any http(s) URL on a site, probes " +
      "<origin>/llms.txt (a curated index of doc links) and, with full=true, <origin>/llms-full.txt " +
      "(the entire docs inlined). Prefer this BEFORE fetch_url on documentation sites — it is the " +
      "cheapest, cleanest source. Returns a clear 'not found' when the site has none.",
    promptSnippet: "Probe a site's /llms.txt (AI doc index) before crawling its docs.",
    parameters: Type.Object({
      url: Type.String({ description: "Any absolute http(s) URL on the target site" }),
      full: Type.Optional(
        Type.Boolean({ description: "Prefer llms-full.txt (entire docs inlined) over the llms.txt index" }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const safe = isSafeUrl(params.url);
      if (!safe.ok) throw new Error(`Refused to fetch: ${safe.reason}`);

      let origin: string;
      try {
        origin = new URL(params.url).origin;
      } catch {
        throw new Error(`Invalid URL: ${params.url}`);
      }

      const candidates = params.full
        ? [`${origin}/llms-full.txt`, `${origin}/llms.txt`]
        : [`${origin}/llms.txt`, `${origin}/llms-full.txt`];

      for (const candidate of candidates) {
        if (!isSafeUrl(candidate).ok) continue;
        const body = await probeLlms(candidate, signal ?? undefined);
        if (!body) continue;
        const kind = candidate.endsWith("llms-full.txt") ? "llms-full" : "llms";
        return buildResult(`# ${candidate}\n\n${body}`, candidate, { url: candidate, origin, kind }, ctx.cwd);
      }

      return {
        content: [
          {
            type: "text",
            text: `No llms.txt or llms-full.txt found at ${origin}. Fall back to fetch_url on the specific page you need.`,
          },
        ],
        details: { origin, found: false },
      };
    },
  });
}
