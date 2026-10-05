import { describe, expect, it } from "vitest";
import { normalizeMcpInput, normalizeSkillMarkdown, publicMcpView, redactSecrets, validateMcpInput, validateResourceName } from "./validation.js";

describe("resource-manager validation", () => {
  it("accepts stable names and rejects traversal", () => {
    expect(validateResourceName("context7.v2")).toBeUndefined();
    expect(validateResourceName("../escape")).toMatch(/名称/);
    expect(validateResourceName("a".repeat(65))).toMatch(/64/);
  });

  it("enforces transport-specific MCP fields", () => {
    expect(validateMcpInput({ name: "x", scope: "global", transport: "stdio" })).toMatch(/command/);
    expect(validateMcpInput({ name: "x", scope: "global", transport: "sse", url: "file:///x" })).toMatch(/http/);
    expect(validateMcpInput({ name: "x", scope: "project", transport: "stdio", command: "npx" })).toBeUndefined();
  });

  it("keeps a remote MCP when the call also carries stdio fields", () => {
    const raw = {
      name: "anysearch",
      scope: "global" as const,
      transport: "sse" as const,
      url: "https://api.anysearch.com/mcp",
      headers: { Authorization: "Bearer ${ANYSEARCH_API_KEY}" },
      command: "npx",
      args: ["-y", "anysearch"],
      env: { ANYSEARCH_API_KEY: "secret-token" },
      cwd: "/tmp",
    };
    const normalized = normalizeMcpInput(raw);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value.input).toEqual({
      name: "anysearch",
      scope: "global",
      transport: "http",
      url: "https://api.anysearch.com/mcp",
      headers: { Authorization: "Bearer ${ANYSEARCH_API_KEY}" },
    });
    expect(normalized.value.ignored).toEqual(["command", "args", "env", "cwd"]);
    expect(publicMcpView(normalized.value.input, normalized.value.ignored, raw).dropped).toEqual({
      command: "npx",
      args: ["-y", "anysearch"],
      env: { ANYSEARCH_API_KEY: "[REDACTED]" },
      cwd: "/tmp",
    });
  });

  it("adds frontmatter but rejects a conflicting skill name", () => {
    expect(normalizeSkillMarkdown("review", "Review code", "# Steps")).toContain("name: review");
    expect(() => normalizeSkillMarkdown("review", "", "---\nname: other\n---\n# X")).toThrow(/other/);
  });

  it("redacts secret values from dependency errors", () => {
    expect(redactSecrets("spawn failed: top-secret-token", ["top-secret-token"])).toBe("spawn failed: [REDACTED]");
  });
});
