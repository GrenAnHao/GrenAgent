import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../_shared/runtime-config.js", () => ({ getConfig: vi.fn() }));

import { getConfig } from "../_shared/runtime-config.js";
import { RepeatGuardConfigError, nextChain, parseRepeatGuardConfig } from "./chain.js";
import loopGuard from "./index.js";

type Handler = (
  event: unknown,
  ctx: unknown,
) => Promise<{ content?: unknown; block?: boolean; structuredContent?: unknown } | undefined>;

function setup() {
  const handlers = new Map<string, Handler>();
  loopGuard({ on: (event: string, handler: Handler) => { handlers.set(event, handler); } } as never);
  return handlers;
}

function ctx(sessionId = "s1") {
  return { cwd: "/proj", sessionManager: { getSessionId: () => sessionId } };
}

function result(toolName: string, input: Record<string, unknown>, text = "ok") {
  return {
    type: "tool_result",
    toolCallId: "c",
    toolName,
    input,
    content: [{ type: "text", text }],
    isError: false,
  };
}

async function repeat(handlers: Map<string, Handler>, times: number, event: ReturnType<typeof result>, sessionId = "s1") {
  const onResult = handlers.get("tool_result")!;
  let last: { content?: unknown; block?: boolean; structuredContent?: unknown } | undefined;
  for (let i = 0; i < times; i++) last = await onResult(event, ctx(sessionId));
  return last;
}

function reminderText(resultValue: { content?: unknown } | undefined): string {
  const content = resultValue?.content as Array<{ text?: string }> | undefined;
  return content?.[content.length - 1]?.text ?? "";
}

beforeEach(() => {
  vi.mocked(getConfig).mockReset();
  vi.mocked(getConfig).mockReturnValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("repeat reminders", () => {
  it("does not register a blocking tool_call hook", () => {
    const handlers = setup();
    expect(handlers.has("tool_call")).toBe(false);
    expect(handlers.has("tool_result")).toBe(true);
  });

  it("leaves the first two identical calls untouched and reminds gently on the third", async () => {
    const handlers = setup();
    const event = result("bash", { command: "rg foo" }, "no matches");
    expect(await repeat(handlers, 2, event)).toBeUndefined();
    const third = await repeat(handlers, 1, event);
    expect(third?.block).toBeUndefined();
    expect(third?.content).toEqual([
      { type: "text", text: "no matches" },
      { type: "text", text: expect.stringContaining("完全相同的参数") },
    ]);
    expect(reminderText(third)).not.toContain("consecutive_calls");
  });

  it("keeps structuredContent when appending a repeat reminder", async () => {
    const handlers = setup();
    const event = {
      ...result("bash", { command: "rg foo" }, "no matches"),
      structuredContent: { output: "full" },
    };
    await repeat(handlers, 2, event);
    const third = await repeat(handlers, 1, event);
    expect(third?.structuredContent).toEqual({ output: "full" });
    expect(third?.content).toEqual([
      { type: "text", text: "no matches" },
      { type: "text", text: expect.stringContaining("完全相同的参数") },
    ]);
  });

  it("stays silent between thresholds, details the later ones, then stops", async () => {
    const handlers = setup();
    const event = result("grep", { pattern: "taobao", path: "index.js" });
    expect(await repeat(handlers, 3, event)).toBeDefined();
    expect(await repeat(handlers, 1, event)).toBeUndefined();
    const fifth = await repeat(handlers, 1, event);
    expect(reminderText(fifth)).toContain("consecutive_calls: 5");
    expect(reminderText(fifth)).toContain("tool: grep");
    expect(reminderText(fifth)).toContain('"path":"index.js"');
    expect(await repeat(handlers, 2, event)).toBeUndefined();
    const eighth = await repeat(handlers, 1, event);
    expect(reminderText(eighth)).toContain("consecutive_calls: 8");
    expect(await repeat(handlers, 1, event)).toBeUndefined();
  });

  it("treats different property order as the same call", async () => {
    const handlers = setup();
    const onResult = handlers.get("tool_result")!;
    await onResult(result("grep", { path: "a.js", pattern: "x" }), ctx());
    await onResult(result("grep", { pattern: "x", path: "a.js" }), ctx());
    const third = await onResult(result("grep", { path: "a.js", pattern: "x" }), ctx());
    expect(reminderText(third)).toContain("完全相同的参数");
  });

  it("resets when the arguments change", async () => {
    const handlers = setup();
    await repeat(handlers, 2, result("bash", { command: "rg foo" }));
    expect(await repeat(handlers, 2, result("bash", { command: "rg bar" }))).toBeUndefined();
    const third = await repeat(handlers, 1, result("bash", { command: "rg bar" }));
    expect(reminderText(third)).toContain("完全相同的参数");
  });

  it("lets excluded tools sit inside a run without resetting it", async () => {
    vi.mocked(getConfig).mockImplementation((key: string) => (key === "LOOP_GUARD_EXCLUDE" ? "todo*" : undefined));
    const handlers = setup();
    const onResult = handlers.get("tool_result")!;
    const grep = result("grep", { pattern: "x" });
    await onResult(grep, ctx());
    await onResult(result("todo_write", { items: ["a"] }), ctx());
    await onResult(grep, ctx());
    const third = await onResult(grep, ctx());
    expect(reminderText(third)).toContain("完全相同的参数");
  });

  it("does not track tools outside include, and does not let them reset the chain", async () => {
    vi.mocked(getConfig).mockImplementation((key: string) => (key === "LOOP_GUARD_INCLUDE" ? "grep" : undefined));
    const handlers = setup();
    const onResult = handlers.get("tool_result")!;
    const grep = result("grep", { pattern: "x" });
    await onResult(grep, ctx());
    await onResult(result("bash", { command: "ls" }), ctx());
    await onResult(grep, ctx());
    const third = await onResult(grep, ctx());
    expect(reminderText(third)).toContain("完全相同的参数");
  });

  it("keeps chains separate per session and clears them on the next user prompt", async () => {
    const handlers = setup();
    const event = result("bash", { command: "rg foo" });
    await repeat(handlers, 2, event, "s1");
    expect(await repeat(handlers, 2, event, "s2")).toBeUndefined();
    const third = await repeat(handlers, 1, event, "s1");
    expect(reminderText(third)).toContain("完全相同的参数");

    await handlers.get("before_agent_start")!({}, ctx("s1"));
    expect(await repeat(handlers, 2, event, "s1")).toBeUndefined();
  });

  it("does not stop a long run of different searches", async () => {
    const handlers = setup();
    const onResult = handlers.get("tool_result")!;
    for (let i = 0; i < 81; i++) {
      const out = await onResult(result("bash", { command: `rg domain-${i}` }), ctx());
      expect(out).toBeUndefined();
    }
  });

  it("does nothing when disabled", async () => {
    vi.mocked(getConfig).mockImplementation((key: string) => (key === "LOOP_GUARD" ? "0" : undefined));
    const handlers = setup();
    expect(await repeat(handlers, 8, result("bash", { command: "rg foo" }))).toBeUndefined();
  });

  it("rejects an invalid threshold list instead of falling back", async () => {
    vi.mocked(getConfig).mockImplementation((key: string) => (key === "LOOP_GUARD_THRESHOLDS" ? "1,3,3" : undefined));
    const handlers = setup();
    await expect(handlers.get("tool_result")!(result("bash", { command: "rg foo" }), ctx())).rejects.toBeInstanceOf(RepeatGuardConfigError);
  });

  it("warns once when the retired call cap is still set", async () => {
    vi.mocked(getConfig).mockImplementation((key: string) => (key === "LOOP_GUARD_MAX_CALLS" ? "80" : undefined));
    const handlers = setup();
    const event = result("bash", { command: "rg foo" });
    await handlers.get("tool_result")!(event, ctx());
    await handlers.get("tool_result")!(event, ctx());
    const messages = vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
    expect(messages.filter((line) => line.includes("LOOP_GUARD_MAX_CALLS"))).toHaveLength(1);
  });
});

describe("parseRepeatGuardConfig", () => {
  it("defaults to 3, 5, 8 and a 500 character preview", () => {
    expect(parseRepeatGuardConfig({})).toMatchObject({
      thresholds: [3, 5, 8],
      include: [],
      exclude: [],
      argumentsPreviewChars: 500,
    });
  });

  it("sorts thresholds and fails on duplicates or values below 2", () => {
    expect(parseRepeatGuardConfig({ thresholds: "8,3,5" }).thresholds).toEqual([3, 5, 8]);
    expect(parseRepeatGuardConfig({ thresholds: "" }).thresholds).toEqual([3, 5, 8]);
    expect(parseRepeatGuardConfig({ argumentsPreviewChars: "" }).argumentsPreviewChars).toBe(500);
    expect(() => parseRepeatGuardConfig({ thresholds: "3,3" })).toThrow(/重复/);
    expect(() => parseRepeatGuardConfig({ thresholds: "1" })).toThrow(/>= 2/);
    expect(() => parseRepeatGuardConfig({ argumentsPreviewChars: "0" })).toThrow(RepeatGuardConfigError);
  });

  it("truncates the quoted arguments without affecting the chain key", () => {
    const config = parseRepeatGuardConfig({ argumentsPreviewChars: "12", thresholds: "2,3" });
    const args = { command: "x".repeat(40) };
    const first = nextChain(undefined, "bash", args, config);
    expect(first.kind).toBe("advance");
    if (first.kind !== "advance") return;
    const second = nextChain(first.chain, "bash", args, config);
    expect(second.kind).toBe("advance");
    if (second.kind !== "advance") return;
    const third = nextChain(second.chain, "bash", args, config);
    expect(third.kind).toBe("advance");
    if (third.kind !== "advance") return;
    expect(third.reminder).toContain("… (+");
    expect(third.reminder).not.toContain("x".repeat(40));
  });
});
