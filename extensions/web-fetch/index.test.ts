import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const crawl = vi.fn();

vi.mock("../web-crawler/index.js", () => ({
  getCrawler: () => ({ crawl }),
}));

import factory from "./index.js";

type Tool = {
  name: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: (
    id: string,
    params: { url: string; format?: string; full?: boolean; headers?: Record<string, string> },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: { cwd: string },
  ) => Promise<{ content: { type: string; text: string }[]; details: Record<string, unknown> }>;
};

function loadTool(): Tool {
  const tools: Tool[] = [];
  factory({
    registerTool(tool: Tool) {
      tools.push(tool);
    },
  } as never);
  expect(tools.map((tool) => tool.name)).toEqual(["fetch_url"]);
  return tools[0]!;
}

const ctx = { cwd: mkdtempSync(join(tmpdir(), "web-fetch-")) };

describe("fetch_url", () => {
  afterEach(() => {
    crawl.mockReset();
    vi.unstubAllGlobals();
  });

  it("is the only registered fetch tool and names itself in the guideline", () => {
    const tool = loadTool();
    expect(tool.promptSnippet?.trim()).toBeTruthy();
    expect(tool.promptGuidelines?.[0]).toMatch(/fetch_url/);
    expect(tool.promptGuidelines?.[0]).toMatch(/format=llms/);
  });

  it("reads html, text, and json with a direct request", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => "<p>Hello</p><script>x</script>",
      json: async () => ({ ok: true }),
      headers: { get: () => "text/html" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = loadTool();

    const html = await tool.execute("1", { url: "https://example.com/a", format: "html" }, undefined, undefined, ctx);
    expect(html.content[0]?.text).toContain("<p>Hello</p>");
    expect(html.details.format).toBe("html");

    const text = await tool.execute("2", { url: "https://example.com/a", format: "text" }, undefined, undefined, ctx);
    expect(text.content[0]?.text).not.toContain("<script>");
    expect(text.details.format).toBe("text");

    const json = await tool.execute("3", { url: "https://example.com/a.json", format: "json" }, undefined, undefined, ctx);
    expect(json.content[0]?.text).toBe('{"ok":true}');
    expect(json.details.format).toBe("json");
    expect(crawl).not.toHaveBeenCalled();
  });

  it("uses the crawler for the default markdown format", async () => {
    crawl.mockResolvedValue({
      crawler: "jina",
      transformedUrl: "https://r.jina.ai/https://example.com",
      data: { contentType: "text/markdown", url: "https://example.com", title: "Example", content: "body" },
    });
    const tool = loadTool();
    const result = await tool.execute("1", { url: "https://example.com" }, undefined, undefined, ctx);
    expect(crawl).toHaveBeenCalledWith({ url: "https://example.com", signal: undefined });
    expect(result.content[0]?.text).toContain("# Example");
    expect(result.content[0]?.text).toContain("body");
    expect(result.details.format).toBe("markdown");
    expect(result.details.crawler).toBe("jina");
  });

  it("probes origin llms.txt and reports a miss", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, headers: { get: () => "" }, text: async () => "" })));
    const tool = loadTool();
    const missed = await tool.execute("1", { url: "https://docs.example.com/guide", format: "llms" }, undefined, undefined, ctx);
    expect(missed.details).toMatchObject({ origin: "https://docs.example.com", format: "llms", found: false });
    expect(missed.content[0]?.text).toContain("No llms.txt");
  });

  it("refuses a loopback URL before any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tool = loadTool();
    await expect(tool.execute("1", { url: "http://127.0.0.1/secret", format: "html" }, undefined, undefined, ctx)).rejects.toThrow(/Refused/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(crawl).not.toHaveBeenCalled();
  });
});
