import { describe, expect, it } from "vitest";
import { isConfined, resolvePreset } from "./resolvePreset.js";

describe("resolvePreset", () => {
  it("Ask forces read-only even when approval is full", () => {
    const p = resolvePreset({
      approval: "full", agentMode: "ask", workspaceRoot: "D:/repo", sessionId: "s1",
    });
    expect(p).toMatchObject({
      mode: "read-only", network: "enabled", workspaceRoot: "D:/repo", sessionId: "s1",
    });
  });
  it.each(["readonly", "ask", "auto", "workspace"] as const)(
    "Ask forces read-only when approval is %s",
    (approval) => {
      expect(resolvePreset({ approval, agentMode: "ask", workspaceRoot: "/w" }).mode).toBe("read-only");
    },
  );
  it("maps the five approvals when not Ask", () => {
    expect(resolvePreset({ approval: "readonly", agentMode: "agent", workspaceRoot: "/w" }).mode).toBe("read-only");
    expect(resolvePreset({ approval: "ask", agentMode: "agent", workspaceRoot: "/w" }).mode).toBe("workspace-write");
    expect(resolvePreset({ approval: "auto", agentMode: "plan", workspaceRoot: "/w" }).mode).toBe("workspace-write");
    expect(resolvePreset({ approval: "workspace", agentMode: "agent", workspaceRoot: "/w" }).mode).toBe("workspace-write");
    expect(resolvePreset({ approval: "full", agentMode: "agent", workspaceRoot: "/w" }).mode).toBe("danger-full-access");
  });
  it("always enables network in spec 1", () => {
    for (const approval of ["readonly", "ask", "auto", "workspace", "full"] as const) {
      expect(resolvePreset({ approval, agentMode: "agent", workspaceRoot: "/w" }).network).toBe("enabled");
    }
  });
});

describe("isConfined", () => {
  it("is true for confined modes and false for danger-full-access", () => {
    expect(isConfined("read-only")).toBe(true);
    expect(isConfined("workspace-write")).toBe(true);
    expect(isConfined("danger-full-access")).toBe(false);
  });
});
