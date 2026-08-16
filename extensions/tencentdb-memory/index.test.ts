import { describe, expect, it, vi } from "vitest";

const memoryClient = {
  searchAtomic: vi.fn(async () => ({ items: [] })),
  readCore: vi.fn(async () => ({ content: "persona", created_at: null, updated_at: null })),
  listScenarios: vi.fn(async () => ({ entries: [], total: 0 })),
  addConversation: vi.fn(async () => undefined),
  withIsolation: vi.fn(),
};
memoryClient.withIsolation.mockReturnValue(memoryClient);

vi.mock("./client.js", () => ({
  createMemoryClient: () => memoryClient,
}));

import tencentdbMemory, {
  MEMORY_RECALL_PROBE_MESSAGE_TYPE,
  memoryRecallProbePrompt,
} from "./index.js";

type Handler = (event: any, ctx: any) => Promise<any> | any;

function setup() {
  const handlers: Record<string, Handler[]> = {};
  const pi = {
    on: (event: string, handler: Handler) => {
      (handlers[event] ??= []).push(handler);
    },
    registerTool: () => undefined,
    appendEntry: () => undefined,
  } as never;
  tencentdbMemory(pi);
  return handlers;
}

function context(abort = vi.fn()) {
  return {
    abort,
    sessionManager: {
      getSessionId: () => "probe-session",
      getEntries: () => [],
    },
  };
}

describe("tencentdb-memory recall probe", () => {
  it("runs the normal recall helper and returns an auditable nonce marker", async () => {
    const handlers = setup();
    const nonce = "8e3b8dd5-9148-47b7-a45f-e4b6d38d30f8";

    const result = await handlers.before_agent_start[0](
      { prompt: memoryRecallProbePrompt(nonce), systemPrompt: "base" },
      context(),
    );

    expect(memoryClient.searchAtomic).toHaveBeenCalledWith({ query: memoryRecallProbePrompt(nonce), limit: 5 });
    expect(memoryClient.readCore).toHaveBeenCalled();
    expect(memoryClient.listScenarios).toHaveBeenCalled();
    expect(result.message).toMatchObject({
      customType: MEMORY_RECALL_PROBE_MESSAGE_TYPE,
      content: nonce,
      display: false,
      details: { nonce },
    });
  });

  it("aborts before provider I/O and does not capture the probe turn", async () => {
    const handlers = setup();
    const abort = vi.fn();
    const ctx = context(abort);
    const nonce = "8e3b8dd5-9148-47b7-a45f-e4b6d38d30f8";

    await handlers.before_agent_start[0](
      { prompt: memoryRecallProbePrompt(nonce), systemPrompt: "base" },
      ctx,
    );
    await handlers.before_provider_request[0]({}, ctx);
    await handlers.agent_end[0]({ messages: [{ role: "user", content: "probe" }] }, ctx);

    expect(abort).toHaveBeenCalledOnce();
    expect(memoryClient.addConversation).not.toHaveBeenCalled();
  });

  it("captures consecutive identical turns instead of treating the second as a retry", async () => {
    const handlers = setup();
    const ctx = context();
    const firstTurn = [
      { role: "user", content: "same prompt" },
      { role: "assistant", content: "same answer" },
    ];

    handlers.agent_end[0]({ messages: firstTurn }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    handlers.agent_end[0]({ messages: [...firstTurn, ...firstTurn] }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(memoryClient.addConversation).toHaveBeenCalledTimes(2);
    expect(memoryClient.addConversation.mock.calls[1][0].messages).toHaveLength(2);
  });
});
