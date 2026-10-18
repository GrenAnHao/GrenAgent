import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { withBashUiDescription } from "./bashUiDescription.js";

describe("withBashUiDescription", () => {
  it("adds a required description parameter next to command", () => {
    const def = {
      name: "bash",
      description: "Execute a bash command.",
      parameters: Type.Object({
        command: Type.String(),
        timeout: Type.Optional(Type.Number()),
      }),
    };
    const next = withBashUiDescription(def);
    const params = next.parameters as {
      properties: Record<string, { description?: string }>;
      required?: string[];
    };
    expect(params.required).toEqual(expect.arrayContaining(["command", "description"]));
    expect(params.required).not.toContain("timeout");
    expect(params.properties.description?.description).toContain("shown in the UI");
    expect(Object.keys(params.properties)[0]).toBe("description");
    expect(next.promptGuidelines).toContain(
      "Always set `description` to 5-10 words of what the command does (shown in the UI); do not put the raw command there.",
    );
    expect(next.description).toContain("description");
    const streaming = next.promptGuidelines.find((g) => g.includes("keeps only the tail"));
    expect(streaming).toMatch(/^bash /);
    expect(streaming).toContain("tail");
    // 过滤管道同样让卡片空到出错或结束：构建进度行全被筛掉。
    expect(streaming).toContain("grep");
    // bash 在 Windows 上也是 Git Bash，不再教 PowerShell 的写法。
    expect(streaming).not.toMatch(/Select-Object|Select-String|Out-String|findstr/);
  });

  it("leaves tools without a command parameter unchanged", () => {
    const def = { name: "read", parameters: Type.Object({ path: Type.String() }) };
    expect(withBashUiDescription(def)).toBe(def);
  });
});
