import { afterEach, describe, expect, it } from "vitest";
import { hasGoalRound, setGoalRoundPending, __resetGoalAuthForTest } from "./auth.js";
import { __resetGoalContinueForTest } from "./continue.js";
import { foldGoal } from "./fold.js";
import factory from "./index.js";
import { getActivation } from "./session.js";
import { DEFAULT_MAX_ROUNDS } from "./types.js";

type Handler = (args: string, ctx: unknown) => Promise<void>;

interface GoalEntry {
  type: string;
  customType: string;
  data: {
    kind: string;
    goalId?: string;
    revision?: number;
    at?: string;
    payload?: Record<string, unknown>;
  };
}

function setup() {
  const entries: GoalEntry[] = [];
  const calls = {
    status: [] as unknown[][],
    notify: [] as unknown[][],
    send: [] as unknown[][],
  };
  const commands: string[] = [];
  const handlers: Record<string, Function> = {};
  let handler: Handler | undefined;
  let description = "";

  factory({
    appendEntry: (t: string, d: unknown) => {
      entries.push({ type: "custom", customType: t, data: d as GoalEntry["data"] });
    },
    sendMessage: (...a: unknown[]) => {
      calls.send.push(a);
    },
    on: (e: string, h: Function) => {
      handlers[e] = h;
    },
    registerCommand: (n: string, def: { handler: Handler; description?: string }) => {
      commands.push(n);
      if (n === "goal") {
        handler = def.handler;
        description = def.description ?? "";
      }
    },
  } as never);

  const ctx = {
    cwd: "/repo",
    ui: {
      notify: (...a: unknown[]) => calls.notify.push(a),
      setStatus: (...a: unknown[]) => calls.status.push(a),
    },
    sessionManager: {
      getEntries: () => entries,
      getSessionId: () => "session-a",
    },
  };

  return { handler: handler as Handler, ctx, calls, commands, handlers, description, entries };
}

function lastNotify(calls: { notify: unknown[][] }): [string, string] {
  return calls.notify.at(-1) as [string, string];
}

function lastEnvelope(calls: { status: unknown[][] }) {
  const pair = calls.status.at(-1) as [string, string];
  expect(pair[0]).toBe("goal");
  return JSON.parse(pair[1]) as {
    schemaVersion: number;
    sessionId: string;
    workspace?: string;
    snapshot: { status?: string; activation?: string; goalId?: string; revision?: number; condition?: string } | null;
    history: unknown[];
  };
}

function goalEvents(entries: GoalEntry[]) {
  return entries.filter((entry) => entry.customType === "goal").map((entry) => entry.data);
}

afterEach(() => {
  delete process.env["goal.autoContinueOnOpen"];
  __resetGoalContinueForTest();
  __resetGoalAuthForTest();
});

describe("goal extension factory", () => {
  it("registers goal plus session_start, input, agent_end, and agent_settled", async () => {
    const { commands, handlers, calls, ctx } = setup();
    expect(commands).toContain("goal");
    expect(Object.keys(handlers)).toEqual(
      expect.arrayContaining(["session_start", "input", "agent_end", "agent_settled"]),
    );

    await handlers.agent_end?.(
      { messages: [{ role: "assistant", stopReason: "aborted" }, { role: "user", stopReason: "error" }] },
      ctx,
    );
    expect(calls.send).toEqual([]);

    await handlers.agent_settled?.({}, ctx);
    expect(calls.send).toEqual([]);
  });

  it("describes a query-first bare command, not /goal 清除", () => {
    const { description } = setup();
    expect(description).toContain("查询");
    expect(description).not.toMatch(/\/goal\s*清除/);
  });

  it("warns on a bare query when no goal is active", async () => {
    const { handler, ctx, calls, entries } = setup();
    await handler("", ctx);
    expect(lastNotify(calls)).toEqual(["当前没有生效的目标。", "warning"]);
    expect(entries).toEqual([]);
  });

  it("creates a goal event, arms status, and notifies an in-progress receipt", async () => {
    const { handler, ctx, calls, entries } = setup();
    await handler("写完", ctx);

    expect(goalEvents(entries)).toEqual([
      expect.objectContaining({
        kind: "create",
        revision: 1,
        payload: { condition: "写完" },
      }),
    ]);

    const envelope = lastEnvelope(calls);
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      sessionId: "session-a",
      workspace: "/repo",
      history: [],
    });
    expect(envelope.snapshot).toMatchObject({ status: "active", activation: "armed", condition: "写完" });

    const [text, level] = lastNotify(calls);
    expect(level).toBe("info");
    expect(text).toContain("执行中的目标");
    expect(text).not.toContain("goalId");
    expect(text).not.toContain("revision");
  });

  it("refuses a second create while an incomplete goal exists", async () => {
    const { handler, ctx, calls, entries } = setup();
    await handler("写完", ctx);
    const before = entries.length;
    await handler("另一条", ctx);
    expect(entries.length).toBe(before);
    expect(goalEvents(entries).every((event) => event.kind === "create")).toBe(true);
    const [text, level] = lastNotify(calls);
    expect(level).toBe("error");
    expect(text).toMatch(/edit|clear/i);
  });

  it("allows create after a complete event without clear, new goalId at revision 1", async () => {
    const { handler, ctx, entries } = setup();
    await handler("旧目标", ctx);
    const created = goalEvents(entries)[0];
    entries.push({
      type: "custom",
      customType: "goal",
      data: {
        kind: "complete",
        goalId: created.goalId,
        revision: 2,
        at: "2026-09-13T00:00:00.000Z",
        payload: {},
      },
    });

    await handler("新目标", ctx);
    const events = goalEvents(entries);
    const next = events.at(-1);
    expect(next).toMatchObject({
      kind: "create",
      revision: 1,
      payload: { condition: "新目标" },
    });
    expect(next?.goalId).toBeTruthy();
    expect(next?.goalId).not.toBe(created.goalId);
  });

  it("creates when the text is pause after verify", async () => {
    const { handler, ctx, entries } = setup();
    await handler("pause after verify", ctx);
    expect(goalEvents(entries)[0]).toMatchObject({
      kind: "create",
      revision: 1,
      payload: { condition: "pause after verify" },
    });
  });

  it("pauses to a disarmed projection", async () => {
    const { handler, ctx, calls, entries } = setup();
    await handler("写完", ctx);
    await handler("pause", ctx);
    expect(goalEvents(entries).at(-1)).toMatchObject({ kind: "pause" });
    expect(lastEnvelope(calls).snapshot).toMatchObject({ status: "paused", activation: "disarmed" });
    expect(lastNotify(calls)[1]).toBe("info");
  });

  it("resumes a paused goal by writing resume and arming", async () => {
    const { handler, ctx, calls, entries } = setup();
    await handler("写完", ctx);
    await handler("pause", ctx);
    await handler("resume", ctx);
    expect(goalEvents(entries).at(-1)).toMatchObject({ kind: "resume" });
    expect(lastEnvelope(calls).snapshot).toMatchObject({ status: "active", activation: "armed" });
    expect(lastNotify(calls)[1]).toBe("info");
  });

  it("re-arms an active disarmed goal on resume without writing a resume event", async () => {
    const { handler, ctx, calls, handlers, entries } = setup();
    await handler("写完", ctx);
    const kindsBefore = goalEvents(entries).map((event) => event.kind);
    await handlers.session_start?.({}, ctx);
    expect(lastEnvelope(calls).snapshot).toMatchObject({ status: "active", activation: "disarmed" });

    await handler("resume", ctx);
    expect(goalEvents(entries).map((event) => event.kind)).toEqual(kindsBefore);
    expect(goalEvents(entries).some((event) => event.kind === "resume")).toBe(false);
    expect(lastEnvelope(calls).snapshot).toMatchObject({ status: "active", activation: "armed" });
  });

  it("clears the goal and pushes a null snapshot", async () => {
    const { handler, ctx, calls, entries } = setup();
    await handler("写完", ctx);
    await handler("clear", ctx);
    expect(goalEvents(entries).at(-1)).toMatchObject({ kind: "clear" });
    const envelope = lastEnvelope(calls);
    expect(envelope.snapshot).toBeNull();
    expect(envelope.history).toEqual([]);
    expect(lastNotify(calls)[1]).toBe("info");
  });

  it("rejects bare edit as a missing-condition error", async () => {
    const { handler, ctx, calls } = setup();
    await handler("edit", ctx);
    const [text, level] = lastNotify(calls);
    expect(level).toBe("error");
    expect(text).toMatch(/缺少|条件/);
  });

  it("rejects edit when no goal is active", async () => {
    const { handler, ctx, calls, entries } = setup();
    await handler("edit 新", ctx);
    expect(entries).toEqual([]);
    expect(lastNotify(calls)).toEqual(["当前没有生效的目标。", "error"]);
  });

  it("uses info for success, error for failure, and warning when no goal", async () => {
    const { handler, ctx, calls } = setup();
    await handler("", ctx);
    expect(lastNotify(calls)[1]).toBe("warning");
    await handler("写完", ctx);
    expect(lastNotify(calls)[1]).toBe("info");
    await handler("另一条", ctx);
    expect(lastNotify(calls)[1]).toBe("error");
    await handler("edit", ctx);
    expect(lastNotify(calls)[1]).toBe("error");
  });

  it("keeps goalId and revision out of notify text", async () => {
    const { handler, ctx, calls } = setup();
    await handler("写完", ctx);
    await handler("pause", ctx);
    await handler("resume", ctx);
    await handler("", ctx);
    await handler("另一条", ctx);
    await handler("clear", ctx);
    await handler("edit", ctx);
    await handler("edit 新", ctx);

    for (const [text] of calls.notify as [string, string][]) {
      expect(text).not.toContain("goalId");
      expect(text).not.toContain("revision");
    }
  });

  it("reenters an armed goal on agent_settled after a normal agent_end", async () => {
    const { handler, ctx, calls, handlers, entries } = setup();
    await handler("写完", ctx);
    const created = goalEvents(entries)[0];

    await handlers.agent_end?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    await handlers.agent_settled?.({}, ctx);

    expect(goalEvents(entries).some((event) => event.kind === "round")).toBe(true);
    expect(calls.send).toHaveLength(1);
    const [message, options] = calls.send[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(message.customType).toBe("goal-round");
    expect(message.display).toBe(false);
    expect(message.details).toEqual({
      goalId: created.goalId,
      revision: 2,
      round: 1,
    });
    expect(options).toEqual({ triggerTurn: true });
  });

  it.each(["aborted", "error"] as const)("does not reenter after assistant %s", async (stopReason) => {
    const { handler, ctx, calls, handlers, entries } = setup();
    await handler("写完", ctx);
    const kindsBefore = goalEvents(entries).map((event) => event.kind);

    await handlers.agent_end?.({ messages: [{ role: "assistant", stopReason }] }, ctx);
    await handlers.agent_settled?.({}, ctx);

    expect(calls.send).toEqual([]);
    expect(goalEvents(entries).map((event) => event.kind)).toEqual(kindsBefore);
    expect(getActivation("session-a")).toBe("armed");
  });

  it("treats settle without a prior agent_end as a normal end and reenters", async () => {
    const { handler, ctx, calls, handlers, entries } = setup();
    await handler("写完", ctx);

    await handlers.agent_settled?.({}, ctx);

    expect(goalEvents(entries).some((event) => event.kind === "round")).toBe(true);
    expect(calls.send).toHaveLength(1);
    const [message] = calls.send[0] as [Record<string, unknown>];
    expect(message.customType).toBe("goal-round");
  });

  it("notifies max rounds once and does not send", async () => {
    const { handler, ctx, calls, handlers, entries } = setup();
    await handler("写完", ctx);
    const created = goalEvents(entries)[0];
    entries.push({
      type: "custom",
      customType: "goal",
      data: {
        kind: "round",
        goalId: created.goalId,
        revision: 2,
        at: "2026-09-13T00:00:00.000Z",
        payload: { round: DEFAULT_MAX_ROUNDS },
      },
    });

    const before = calls.notify.length;
    await handlers.agent_end?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    await handlers.agent_settled?.({}, ctx);
    expect(calls.send).toEqual([]);
    expect(goalEvents(entries).filter((event) => event.kind === "round")).toHaveLength(1);
    const first = calls.notify.slice(before) as [string, string][];
    expect(first.some(([text, level]) => text.includes("已达轮次上限") && (level === "warning" || level === "info"))).toBe(true);

    const mid = calls.notify.length;
    await handlers.agent_settled?.({}, ctx);
    const second = calls.notify.slice(mid) as [string, string][];
    expect(second.some(([text]) => text.includes("已达轮次上限"))).toBe(false);
    expect(calls.send).toEqual([]);
  });

  it("clears the previous pending mark and sets the folded one on reenter", async () => {
    const { handler, ctx, handlers, entries } = setup();
    await handler("写完", ctx);
    const created = goalEvents(entries)[0];
    const oldRef = { goalId: created.goalId as string, revision: 1, round: 0 };
    setGoalRoundPending("session-a", oldRef);

    await handlers.agent_end?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    await handlers.agent_settled?.({}, ctx);

    const snapshot = foldGoal(entries);
    expect(snapshot).toBeTruthy();
    expect(hasGoalRound("session-a", oldRef)).toBe(false);
    expect(hasGoalRound("session-a", {
      goalId: snapshot!.goalId,
      revision: snapshot!.revision,
      round: snapshot!.roundsStarted,
    })).toBe(true);
  });

  it("clears the previous pending mark when abort prevents reenter", async () => {
    const { handler, ctx, calls, handlers, entries } = setup();
    await handler("写完", ctx);
    const created = goalEvents(entries)[0];
    const oldRef = { goalId: created.goalId as string, revision: 1, round: 0 };
    setGoalRoundPending("session-a", oldRef);

    await handlers.agent_end?.({ messages: [{ role: "assistant", stopReason: "aborted" }] }, ctx);
    await handlers.agent_settled?.({}, ctx);

    expect(calls.send).toEqual([]);
    expect(hasGoalRound("session-a", oldRef)).toBe(false);
  });
});

