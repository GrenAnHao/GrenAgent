import { describe, expect, it } from "vitest";
import { annotateWindowsBashTool } from "./windowsBashPrompt.js";

const base = {
  name: "bash",
  description: "Execute a bash command.",
  promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
  promptGuidelines: ["Do not leak PI_* environment variables."],
};

describe("annotateWindowsBashTool", () => {
  it("leaves POSIX definitions unchanged", () => {
    expect(annotateWindowsBashTool(base, "linux")).toEqual(base);
  });

  it("rewrites snippet and appends description plus guidelines on win32", () => {
    const next = annotateWindowsBashTool(base, "win32");
    expect(next.promptSnippet).toBe(
      "Execute PowerShell for programs. List and search files with ls, find, grep, or search, not bash.",
    );
    expect(next.promptSnippet).not.toContain("Get-ChildItem");
    expect(next.description).toContain("PowerShell");
    expect(next.description).toContain("exit $LASTEXITCODE");
    expect(next.description).toContain("Do not pass ls -la");
    expect(next.description).toContain("ripgrep");
    expect(next.description).toContain("Do not use Get-ChildItem, Select-String, or Get-Content");
    expect(next.promptGuidelines).toHaveLength(2);
    expect(next.promptGuidelines[0]).toBe(base.promptGuidelines[0]);
    expect(next.promptGuidelines[1]).toContain("PowerShell");
    expect(next.promptGuidelines[1]).toContain("ripgrep");
    expect(next.promptGuidelines[1]).toContain("exit $LASTEXITCODE");
    expect(next.promptGuidelines[1]).toContain("Do not call bash for Get-ChildItem, Select-String, or Get-Content");
  });
});
