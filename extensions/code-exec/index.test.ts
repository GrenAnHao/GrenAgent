import { describe, expect, it } from "vitest";
import codeExec from "./index.js";

describe("code-exec extension", () => {
  it("registers py and js run/reset tools", () => {
    const names: string[] = [];
    const pi = {
      registerTool: (tool: { name: string }) => {
        names.push(tool.name);
      },
      on: () => {},
    };
    codeExec(pi as unknown as Parameters<typeof codeExec>[0]);
    expect(names).toEqual(["py_run", "py_reset", "js_run", "js_reset"]);
  });

  it("returns a text-only result when resetting an unstarted Python kernel", async () => {
    const tools: Array<{
      name: string;
      execute: (
        ...args: [
          toolCallId: string,
          params: Record<string, never>,
          signal: AbortSignal | undefined,
          onUpdate: undefined,
          ctx: { cwd: string },
        ]
      ) => Promise<unknown>;
    }> = [];
    const pi = {
      registerTool: (tool: (typeof tools)[number]) => {
        tools.push(tool);
      },
      on: () => {},
    };
    codeExec(pi as unknown as Parameters<typeof codeExec>[0]);

    const result = await tools.find((tool) => tool.name === "py_reset")!.execute(
      "call",
      {},
      undefined,
      undefined,
      { cwd: process.cwd() },
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "内核尚未启动，无需重置。" }],
      details: undefined,
    });
  });
});
