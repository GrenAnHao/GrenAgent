import { describe, expect, it } from "vitest";
import factory from "./index.js";

type Handler = (args: string, ctx: unknown) => Promise<void>;

function setup(client: { request: (...args: unknown[]) => Promise<unknown> } = { request: async () => undefined }) {
  const calls = {
    status: [] as unknown[][],
    notify: [] as unknown[][],
    entries: [] as unknown[][],
  };
  const commands: string[] = [];
  const events: string[] = [];
  let handler: Handler | undefined;
  factory({
    registerCommand: (n: string, def: { handler: Handler }) => {
      commands.push(n);
      if (n === "goal") handler = def.handler;
    },
    on: (e: string) => events.push(e),
    appendEntry: (t: string, d: unknown) => calls.entries.push([t, d]),
  } as never, client as never);
  const ctx = {
    cwd: 'C:/work',
    ui: {
      notify: (...a: unknown[]) => calls.notify.push(a),
      setStatus: (...a: unknown[]) => calls.status.push(a),
    },
    model: undefined,
    modelRegistry: { find: () => undefined },
    sessionManager: { getSessionId: () => 'session-a' },
  };
  return { handler: handler as Handler, ctx, calls, commands, events };
}

const lastStatus = (calls: { status: unknown[][] }) => calls.status.at(-1) as [string, string | undefined];

describe("goal extension factory", () => {
  it("registers /goal command and session_start/agent_end hooks", () => {
    const { commands, events } = setup();
    expect(commands).toContain("goal");
    expect(events).toEqual(expect.arrayContaining(["session_start", "agent_end"]));
  });

  it("setting a goal persists through the current session RPC", async () => {
    const client = { request: async (method: string, params: Record<string, unknown>) => method === 'goal.get'
      ? undefined
      : { goalId: 'g', sessionId: params.sessionId, workspace: params.workspace, revision: 1, condition: params.condition, status: 'active', roundsUsed: 0, maxRounds: 256 } };
    const { handler, ctx, calls } = setup(client);
    await handler("写完并通过测试", ctx);
    const [key, text] = lastStatus(calls);
    expect(key).toBe("goal");
    expect(JSON.parse(text as string)).toMatchObject({ condition: "写完并通过测试", status: 'active' });
  });

  it("queues a desktop-managed Turn when the Electron control plane is available", async () => {
    const calls: string[] = [];
    const client = { request: async (method: string) => { calls.push(method); return undefined; } };
    const { handler, ctx } = setup(client);
    await handler("完成统一事件迁移", ctx);
    expect(calls).toEqual(['goal.get', 'goal.create']);
  });

  it("pause then resume toggles the pushed paused flag", async () => {
    let snapshot: any = undefined;
    const client = { request: async (method: string, params: Record<string, unknown>) => {
      if (method === 'goal.get') return snapshot;
      snapshot = { goalId: 'g', sessionId: 'session-a', workspace: 'C:/work', revision: (snapshot?.revision ?? 0) + 1, condition: '目标X', status: params.action === 'pause' ? 'paused' : 'active', roundsUsed: 0, maxRounds: 256 };
      return snapshot;
    } };
    const { handler, ctx, calls } = setup(client);
    await handler("目标X", ctx);
    await handler("pause", ctx);
    expect(JSON.parse(lastStatus(calls)[1] as string)).toMatchObject({ status: 'paused' });
    await handler("resume", ctx);
    expect(JSON.parse(lastStatus(calls)[1] as string)).toMatchObject({ status: 'active' });
  });

  it("clear removes the goal (status pushed undefined)", async () => {
    let snapshot: any;
    const client = { request: async (method: string, params: Record<string, unknown>) => {
      if (method === 'goal.get') return snapshot;
      if (params.action === 'clear') return snapshot = { ...snapshot, status: 'cleared', revision: snapshot.revision + 1 };
      return snapshot = { goalId: 'g', sessionId: 'session-a', workspace: 'C:/work', revision: 1, condition: '目标X', status: 'active', roundsUsed: 0, maxRounds: 256 };
    } };
    const { handler, ctx, calls } = setup(client);
    await handler("目标X", ctx);
    await handler("clear", ctx);
    expect(JSON.parse(lastStatus(calls)[1] as string)).toMatchObject({ status: 'cleared' });
  });

  it("pause without an active goal warns and drives nothing", async () => {
    const { handler, ctx, calls } = setup();
    await handler("pause", ctx);
    expect(calls.notify.at(-1)).toEqual(["当前没有生效的目标。", "warning"]);
  });
});
