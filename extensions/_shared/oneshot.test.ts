import { describe, expect, it, vi } from "vitest";
import { runOneshotWithRuntime } from "./oneshot.js";

describe("runOneshotWithRuntime", () => {
  it("非流式 emit formatNonStream 形状", async () => {
    const emit = vi.fn();
    await runOneshotWithRuntime(
      {
        getModel: () => ({}),
        completeSimple: async () => ({ content: [{ type: "text", text: "hello" }] }) as never,
        streamSimple: async function* () {} as never,
      },
      { provider: "openai", modelId: "gpt", user: "hi" },
      emit,
    );
    expect(emit).toHaveBeenCalledWith({ ok: true, content: "hello" });
  });

  it("流式行是 delta/done/error", async () => {
    const emit = vi.fn();
    await runOneshotWithRuntime(
      {
        getModel: () => ({}),
        completeSimple: async () => ({ content: [] }) as never,
        streamSimple: async function* () {
          yield { type: "text_delta", delta: "A" };
          yield { type: "done", message: { usage: { input: 1, output: 2 } } };
        } as never,
      },
      { provider: "openai", modelId: "gpt", user: "hi", stream: true },
      emit,
    );
    expect(emit.mock.calls.map((c) => c[0])).toEqual([
      { type: "delta", text: "A" },
      { type: "done", usage: { input: 1, output: 2 } },
    ]);
  });

  it("模型不存在时 emit ok:false", async () => {
    const emit = vi.fn();
    await runOneshotWithRuntime(
      { getModel: () => undefined, completeSimple: async () => ({}) as never, streamSimple: async function* () {} as never },
      { provider: "x", modelId: "y", user: "hi" },
      emit,
    );
    expect(emit).toHaveBeenCalledWith({ ok: false, error: "model not found: x/y" });
  });
});
