import { describe, expect, it } from "vitest";
import { diffServers } from "./diff.js";
import type { McpServerConfig } from "./config.js";

const s = (name: string, command = "x"): McpServerConfig => ({ name, transport: "stdio", command, args: [] });

describe("diffServers", () => {
  it("detects added", () => {
    const d = diffServers([s("a")], [s("a"), s("b")]);
    expect(d.added.map((x) => x.name)).toEqual(["b"]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([]);
  });
  it("detects removed", () => {
    const d = diffServers([s("a"), s("b")], [s("a")]);
    expect(d.removed).toEqual(["b"]);
  });
  it("detects changed (command differs)", () => {
    const d = diffServers([s("a", "old")], [s("a", "new")]);
    expect(d.changed.map((x) => x.name)).toEqual(["a"]);
  });
  it("no change when identical", () => {
    const d = diffServers([s("a")], [s("a")]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([]);
  });
  it("detects changed remote headers", () => {
    const prev: McpServerConfig = { name: "api", transport: "http", url: "http://x/mcp", headers: { "x-api-key": "old" } };
    const next: McpServerConfig = { name: "api", transport: "http", url: "http://x/mcp", headers: { "x-api-key": "new" } };
    expect(diffServers([prev], [next]).changed.map((x) => x.name)).toEqual(["api"]);
  });
});
