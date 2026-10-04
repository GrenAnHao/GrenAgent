import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../_shared/runtime-config.js", () => ({ getConfig: vi.fn() }));
vi.mock("../diagnostics/config.js", () => ({ resolveCommands: vi.fn() }));
vi.mock("../diagnostics/runner.js", () => ({ runChecks: vi.fn() }));

import { getConfig } from "../_shared/runtime-config.js";
import { resolveCommands } from "../diagnostics/config.js";
import { runChecks } from "../diagnostics/runner.js";
import afterToolFeedback from "./index.js";

type Handler = (
  event: unknown,
  ctx: unknown,
) => Promise<{ content?: unknown; structuredContent?: unknown } | undefined>;

function setup() {
  const handlers = new Map<string, Handler>();
  afterToolFeedback({
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
  } as never);
  return handlers;
}

beforeEach(() => {
  vi.mocked(getConfig).mockReset();
  vi.mocked(getConfig).mockReturnValue(undefined);
  vi.mocked(resolveCommands).mockReset();
  vi.mocked(runChecks).mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("tool_result handler", () => {
  it("keeps structuredContent when patching diagnostics into the result", async () => {
    vi.mocked(resolveCommands).mockReturnValue([["npx", "tsc", "--noEmit"]]);
    vi.mocked(runChecks).mockResolvedValue([
      {
        source: "tsc",
        stdout: "src/a.ts(1,1): error TS2322: Type 'x' is not assignable\n",
        stderr: "",
      },
    ]);

    const handlers = setup();
    const onResult = handlers.get("tool_result")!;
    const event = {
      type: "tool_result",
      toolCallId: "c1",
      toolName: "edit",
      input: { path: "src/a.ts" },
      content: [{ type: "text", text: "edited a.ts" }],
      isError: false,
      structuredContent: { output: "full" },
    };

    const out = await onResult(event, { cwd: "/proj", signal: undefined });
    expect(out?.structuredContent).toEqual({ output: "full" });
    expect(out?.content).toEqual([
      { type: "text", text: "edited a.ts" },
      { type: "text", text: expect.stringContaining("[写后诊断]") },
    ]);
  });
});
