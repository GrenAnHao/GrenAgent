import { describe, expect, it } from "vitest";
import { listGoalHistory } from "./history.js";
import type { GoalEvent } from "./types.js";

const at = "2026-09-13T00:00:00.000Z";

function ev(event: GoalEvent) {
  return { type: "custom", customType: "goal", data: event, timestamp: event.at };
}

describe("listGoalHistory", () => {
  it("maps valid goal events to source=event items", () => {
    const items = listGoalHistory([
      ev({ kind: "create", goalId: "g1", revision: 1, at, payload: { condition: "写完" } }),
    ]);
    expect(items).toEqual([
      expect.objectContaining({
        source: "event",
        kind: "create",
        revision: 1,
        at,
        payload: { condition: "写完" },
      }),
    ]);
  });

  it("maps goal-round details+content and data-shaped entries to source=round", () => {
    const items = listGoalHistory([
      {
        type: "custom",
        customType: "goal-round",
        details: { goalId: "g1", revision: 2, round: 1 },
        content: "正文",
      },
      {
        type: "custom",
        customType: "goal-round",
        data: { goalId: "g1", revision: 3, round: 2, content: "data 正文" },
      },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      source: "round",
      goalId: "g1",
      revision: 2,
      round: 1,
      content: "正文",
    });
    expect(items[1]).toMatchObject({
      source: "round",
      goalId: "g1",
      revision: 3,
      round: 2,
      content: "data 正文",
    });
  });

  it("excludes kind-less legacy { condition, react } goal entries", () => {
    expect(listGoalHistory([
      { type: "custom", customType: "goal", data: { condition: "x", react: true } },
    ])).toEqual([]);
  });

  it("excludes goal entries with illegal kind or missing goalId", () => {
    expect(listGoalHistory([
      {
        type: "custom",
        customType: "goal",
        data: { kind: "begin_judging", goalId: "g", revision: 1, at, payload: {} },
      },
      {
        type: "custom",
        customType: "goal",
        data: { kind: "create", revision: 1, at, payload: { condition: "x" } },
      },
      ev({ kind: "create", goalId: "g1", revision: 1, at, payload: { condition: "ok" } }),
    ])).toEqual([
      expect.objectContaining({ source: "event", kind: "create", revision: 1 }),
    ]);
  });

  it("keeps appearance order: create, then round body, then pause", () => {
    const items = listGoalHistory([
      ev({ kind: "create", goalId: "g1", revision: 1, at, payload: { condition: "写完" } }),
      {
        type: "custom",
        customType: "goal-round",
        details: { goalId: "g1", revision: 1, round: 1 },
        content: "正文",
      },
      ev({ kind: "pause", goalId: "g1", revision: 2, at, payload: { reason: "user" } }),
    ]);
    expect(items.map((item) => (item.source === "event" ? item.kind : `round:${item.round}`))).toEqual([
      "create",
      "round:1",
      "pause",
    ]);
  });
});
