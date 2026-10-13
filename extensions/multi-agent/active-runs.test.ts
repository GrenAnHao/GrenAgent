import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetActiveRunsForTest, acquireActiveSlot, activeRuns, DEFAULT_MAX_ACTIVE, maxActiveSubagents } from "./active-runs.js";

const origMax = process.env.SUBAGENT_MAX_ACTIVE;

beforeEach(() => {
  __resetActiveRunsForTest();
  delete process.env.SUBAGENT_MAX_ACTIVE;
});

afterEach(() => {
  if (origMax === undefined) delete process.env.SUBAGENT_MAX_ACTIVE;
  else process.env.SUBAGENT_MAX_ACTIVE = origMax;
});

describe("active sub-agent slots", () => {
  it("defaults to DSH's 8 and reads SUBAGENT_MAX_ACTIVE", () => {
    expect(maxActiveSubagents()).toBe(DEFAULT_MAX_ACTIVE);
    expect(DEFAULT_MAX_ACTIVE).toBe(8);
    process.env.SUBAGENT_MAX_ACTIVE = "3";
    expect(maxActiveSubagents()).toBe(3);
  });

  it("queues past the limit and lets the next one in when a slot is released", async () => {
    process.env.SUBAGENT_MAX_ACTIVE = "2";
    const a = await acquireActiveSlot({ childId: "a", backend: "in-process", depth: 1 });
    await acquireActiveSlot({ childId: "b", backend: "worker", depth: 1 });
    let third = false;
    const pending = acquireActiveSlot({ childId: "c", backend: "in-process", depth: 1 }).then((release) => {
      third = true;
      return release;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(third).toBe(false);
    expect(activeRuns().map((r) => r.childId)).toEqual(["a", "b"]);
    a();
    a(); // 重复释放无害
    await pending;
    expect(third).toBe(true);
    expect(activeRuns().map((r) => r.childId).sort()).toEqual(["b", "c"]);
  });

  it("nested children are counted but never wait (no deadlock with parents holding every slot)", async () => {
    process.env.SUBAGENT_MAX_ACTIVE = "1";
    await acquireActiveSlot({ childId: "parent-child", backend: "in-process", depth: 1 });
    const release = await acquireActiveSlot({ childId: "grandchild", backend: "in-process", depth: 2 });
    expect(activeRuns().map((r) => r.childId)).toEqual(["parent-child", "grandchild"]);
    release();
  });

  it("a cancelled waiter gives up instead of taking a slot later", async () => {
    process.env.SUBAGENT_MAX_ACTIVE = "1";
    await acquireActiveSlot({ childId: "a", backend: "in-process", depth: 1 });
    const controller = new AbortController();
    const waiting = acquireActiveSlot({ childId: "b", backend: "in-process", depth: 1 }, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow(/cancelled while waiting/);
    expect(activeRuns().map((r) => r.childId)).toEqual(["a"]);
  });
});
