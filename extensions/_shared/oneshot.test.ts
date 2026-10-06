import { describe, expect, it, vi } from "vitest";
import { formatNonStream, runOneshotWithRuntime } from "./oneshot.js";

describe("formatNonStream", () => {
  it("provider 报错时透出 errorMessage，不再报成 empty content", () => {
    expect(formatNonStream({ content: [], stopReason: "error", errorMessage: "429 rate limited" }))
      .toEqual({ ok: false, error: "429 rate limited" });
    expect(formatNonStream({ content: [], stopReason: "aborted" })).toEqual({ ok: false, error: "model aborted" });
  });

  it("正常结束但没有文本时保留 empty content 前缀，并带上结束原因与块类型", () => {
    expect(formatNonStream({ content: [{ type: "thinking" }, { type: "text", text: " " }], stopReason: "length" }))
      .toEqual({ ok: false, error: "empty content (stopReason=length, blocks=thinking,text)" });
    expect(formatNonStream({ content: [] })).toEqual({ ok: false, error: "empty content (stopReason=unknown, blocks=none)" });
  });

  it("有文本时原样返回内容与 usage", () => {
    expect(formatNonStream({ content: [{ type: "text", text: "ok" }], stopReason: "stop", usage: { input: 1 } }))
      .toEqual({ ok: true, content: "ok", usage: { input: 1 } });
  });
});

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
