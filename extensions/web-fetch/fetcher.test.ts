import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchHtml, fetchJson, fetchMarkdown, fetchTxt } from "./fetcher.js";

const mockHtml = `<!DOCTYPE html>
<html>
  <head>
    <title>Test Page</title>
    <script>console.log('remove');</script>
    <style>body { color: red; }</style>
  </head>
  <body>
    <h1>Hello World</h1>
    <p>This is a test paragraph.</p>
  </body>
</html>`;

describe("fetcher", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        text: async () => mockHtml,
        json: async () => ({ key: "value" }),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetchHtml returns raw HTML", async () => {
    const html = await fetchHtml({ url: "https://example.com" });
    expect(html).toBe(mockHtml);
  });

  it("fetchMarkdown strips scripts/styles and converts headings", async () => {
    const md = await fetchMarkdown({ url: "https://example.com" });
    expect(md).toContain("# Hello World");
    expect(md).toContain("This is a test paragraph.");
    expect(md).not.toContain("<script");
  });

  it("fetchTxt returns plain text without tags", async () => {
    const text = await fetchTxt({ url: "https://example.com" });
    expect(text).toContain("Hello World");
    expect(text).toContain("This is a test paragraph.");
    expect(text).not.toContain("<h1");
    expect(text).not.toContain("console.log");
  });

  it("fetchJson stringifies JSON body", async () => {
    const json = await fetchJson({ url: "https://example.com/data.json" });
    expect(json).toBe('{"key":"value"}');
  });

  it("passes custom headers to fetch", async () => {
    await fetchHtml({ url: "https://example.com", headers: { Authorization: "Bearer x" } });
    expect(fetch).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer x" }),
      }),
    );
  });

  it("throws on non-OK HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
      })),
    );
    await expect(fetchHtml({ url: "https://example.com/missing" })).rejects.toThrow("HTTP error: 404");
  });

  it("wraps network errors with URL context", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("Network error"))));
    await expect(fetchHtml({ url: "https://example.com" })).rejects.toThrow(
      "Failed to fetch https://example.com: Network error",
    );
  });

  it("aborts slow body reads within FETCH_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => ({
        ok: true,
        text: async () => {
          const signal = init?.signal;
          if (signal instanceof AbortSignal && signal.aborted) {
            throw new DOMException("Aborted", "AbortError");
          }
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
              once: true,
            });
          });
          return mockHtml;
        },
      })),
    );

    const pending = fetchHtml({ url: "https://example.com" });
    const assertion = expect(pending).rejects.toThrow(/Failed to fetch https:\/\/example.com/);
    await vi.advanceTimersByTimeAsync(15000);
    await assertion;
    vi.useRealTimers();
  });
});
