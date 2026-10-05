// 移植自 DSH packages/jobs/jobs-local/tests/pump.spec.ts
import { describe, expect, it, vi } from "vitest";
import { startPump, type PumpSink } from "./pump.js";
import type { JobAppendOptions, JobOutputSource } from "./types.js";

function recorder() {
  const appends: { text: string; options?: JobAppendOptions }[] = [];
  const spills: [number, string | undefined][] = [];
  const sink: PumpSink = {
    append: (text, options) => {
      appends.push({ text, ...(options !== undefined ? { options } : {}) });
    },
    spill: (index, path) => {
      spills.push([index, path]);
    },
  };
  return { appends, spills, sink };
}

function scriptedSource(
  reads: { text: string; lossy?: boolean; spillPath?: string }[],
  channel?: "stdout" | "stderr",
): { source: JobOutputSource; offsets: number[] } {
  const offsets: number[] = [];
  let offset = 0;
  const source: JobOutputSource = {
    ...(channel !== undefined ? { channel } : {}),
    read(fromByte) {
      offsets.push(fromByte);
      const next = reads.shift() ?? { text: "" };
      offset += Buffer.byteLength(next.text, "utf8");
      return {
        text: next.text,
        nextOffset: offset,
        lossy: next.lossy ?? false,
        ...(next.spillPath !== undefined ? { spillPath: next.spillPath } : {}),
      };
    },
  };
  return { source, offsets };
}

describe("startPump", () => {
  it("copies labeled deltas at the poll cadence and resumes each source at its own offset", async () => {
    vi.useFakeTimers();
    try {
      const { appends, sink } = recorder();
      let settle!: () => void;
      const until = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const out = scriptedSource([{ text: "a" }, { text: "bc" }], "stdout");
      const err = scriptedSource([{ text: "" }, { text: "E" }], "stderr");
      const pump = startPump([out.source, err.source], sink, 50, until);

      await vi.advanceTimersByTimeAsync(50);
      settle();
      await pump.done;
      expect(appends).toEqual([
        { text: "a", options: { channel: "stdout" } },
        { text: "bc", options: { channel: "stdout" } },
        { text: "E", options: { channel: "stderr" } },
      ]);
      expect(out.offsets).toEqual([0, 1, 3]);
      expect(err.offsets).toEqual([0, 0, 1]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a lossy source read as a gap so observers see the discontinuity", async () => {
    const { appends, sink } = recorder();
    const { source } = scriptedSource([{ text: "tail", lossy: true }]);
    await startPump([source], sink, 1, Promise.resolve()).done;
    expect(appends).toEqual([{ text: "tail", options: { gapBefore: true } }]);
  });

  it("reports each source's spill file on every read and withdraws it once a read stops naming it", async () => {
    vi.useFakeTimers();
    try {
      const { appends, spills, sink } = recorder();
      let settle!: () => void;
      const until = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const out = scriptedSource(
        [{ text: "tail", lossy: true, spillPath: "/spill/out.log" }, { text: "more", spillPath: "/spill/out.log" }, { text: "" }],
        "stdout",
      );
      const err = scriptedSource([{ text: "" }, { text: "E", spillPath: "/spill/err.log" }], "stderr");
      const pump = startPump([out.source, err.source], sink, 50, until);

      await vi.advanceTimersByTimeAsync(50);
      settle();
      await pump.done;
      expect(appends).toEqual([
        { text: "tail", options: { channel: "stdout", gapBefore: true } },
        { text: "more", options: { channel: "stdout" } },
        { text: "E", options: { channel: "stderr" } },
      ]);
      expect(spills).toEqual([
        [0, "/spill/out.log"], [1, undefined],
        [0, "/spill/out.log"], [1, "/spill/err.log"],
        [0, undefined], [1, undefined],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a rejected settlement as settlement and still drains the final bytes", async () => {
    const { appends, sink } = recorder();
    const { source } = scriptedSource([{ text: "last" }]);
    await startPump([source], sink, 1, Promise.reject(new Error("producer broke"))).done;
    expect(appends).toEqual([{ text: "last" }]);
  });

  it("holds one poll timer however long the job runs", async () => {
    vi.useFakeTimers();
    try {
      const { sink } = recorder();
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const { source, offsets } = scriptedSource([]);
      const pump = startPump([source], sink, 50, settled);
      const rounds = 1_000;
      await vi.advanceTimersByTimeAsync(50 * rounds);
      expect(offsets).toHaveLength(rounds + 1);
      expect(vi.getTimerCount()).toBe(1);
      settle();
      await pump.done;
      expect(offsets).toHaveLength(rounds + 2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a non-positive poll interval before touching any source", () => {
    const { sink } = recorder();
    expect(() => startPump([], sink, 0, Promise.resolve())).toThrow(/invalid pump pollMs/);
  });
});
