import { describe, expect, it } from "vitest";
import {
  CODE_EXEC_TOOLS,
  HOST_FALLBACK_EXEC_TOOLS,
  HOST_ONLY_EXEC_TOOLS,
  NET_TOOLS,
  SANDBOXABLE_EXEC_TOOLS,
  WRITE_TOOLS,
} from "./tool-groups.js";

describe("tool-groups", () => {
  it("NET_TOOLS lists real registered networking tools (no phantom names)", () => {
    // 真实注册的联网工具（web-search / web-fetch / github）。
    expect(NET_TOOLS).toContain("web_search");
    expect(NET_TOOLS).toContain("web_search_multi");
    expect(NET_TOOLS).toContain("fetch_url");
    expect(NET_TOOLS).toContain("fetch_llms");
    expect(NET_TOOLS).toContain("fetch_html");
    expect(NET_TOOLS).toContain("fetch_markdown");
    expect(NET_TOOLS).toContain("fetch_txt");
    expect(NET_TOOLS).toContain("fetch_json");
    expect(NET_TOOLS).toContain("github");
    // 历史失配的幻影名不得再出现。
    expect(NET_TOOLS as readonly string[]).not.toContain("web_fetch");
    expect(NET_TOOLS as readonly string[]).not.toContain("web_crawler");
    // search 现归 batch-tools 的本地代码检索（只读、非联网），不得被当作联网工具门控。
    expect(NET_TOOLS as readonly string[]).not.toContain("search");
  });

  it("WRITE_TOOLS are the write-allowlist bypass writers", () => {
    expect([...WRITE_TOOLS].sort()).toEqual(["ast_edit", "hl_edit"]);
  });

  it("CODE_EXEC_TOOLS = sandboxable ∪ host-only, deduped", () => {
    expect([...CODE_EXEC_TOOLS].sort()).toEqual(
      [...new Set([...SANDBOXABLE_EXEC_TOOLS, ...HOST_ONLY_EXEC_TOOLS])].sort(),
    );
    expect(new Set(CODE_EXEC_TOOLS).size).toBe(CODE_EXEC_TOOLS.length);
  });

  it("HOST_FALLBACK_EXEC_TOOLS ⊂ SANDBOXABLE (and excludes sandbox_sh)", () => {
    for (const t of HOST_FALLBACK_EXEC_TOOLS) expect(SANDBOXABLE_EXEC_TOOLS).toContain(t);
    expect(HOST_FALLBACK_EXEC_TOOLS as readonly string[]).not.toContain("sandbox_sh");
  });
});
