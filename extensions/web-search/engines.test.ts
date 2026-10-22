import { describe, expect, it } from "vitest";
import { defaultSearchChain, parseBaidu, parseEngineChain, resolveWebSearchChain, runEngineChain } from "./engines/index.js";

describe("parseBaidu", () => {
  it("parses #content_left blocks with h3/a and cos-row snippet", () => {
    const html = `
      <div id="content_left">
        <div class="result">
          <h3><a href="https://example.com/a">Example A</a></h3>
          <div class="cos-row">Snippet one</div>
        </div>
        <div class="result">
          <h3><a href="/relative">Skip relative</a></h3>
        </div>
        <div class="result">
          <h3><a href="https://example.com/b">Example B</a></h3>
          <span class="c-font-normal c-color-text" aria-label="Aria snippet"></span>
        </div>
      </div>`;
    expect(parseBaidu(html)).toEqual([
      { title: "Example A", url: "https://example.com/a", snippet: "Snippet one" },
      { title: "Example B", url: "https://example.com/b", snippet: "Aria snippet" },
    ]);
  });
});

describe("parseEngineChain", () => {
  it("dedupes and filters unknown engines", () => {
    expect(parseEngineChain("bing, baidu, bing, foo, csdn, exa")).toEqual(["bing", "baidu"]);
    expect(parseEngineChain("devin, bing")).toEqual(["bing"]);
  });
});

describe("defaultSearchChain", () => {
  it("falls back from bing to sogou and baidu, and lets an explicit list win", () => {
    expect(defaultSearchChain("bing")).toEqual(["bing", "sogou", "baidu"]);
    expect(defaultSearchChain("sogou")).toEqual(["sogou", "baidu"]);
    expect(resolveWebSearchChain(["duckduckgo"], "bing")).toEqual(["duckduckgo"]);
  });

  it("keeps later engines when an earlier one fails", async () => {
    const out = await runEngineChain(["sogou", "bing"], "q", 8, undefined, async (engine) => {
      if (engine === "sogou") throw new Error("sogou down");
      return { results: [{ title: "B", url: "https://b.example", snippet: "s" }] };
    });
    expect(out.engine).toBe("bing");
    expect(out.parsed.results).toEqual([{ title: "B", url: "https://b.example", snippet: "s" }]);
  });
});
