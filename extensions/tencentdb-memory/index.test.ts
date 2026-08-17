import { beforeEach, describe, expect, it, vi } from "vitest";

const memoryClient = {
  searchAtomic: vi.fn(async () => ({ items: [] })),
  readCore: vi.fn(async () => ({ content: "persona", created_at: null, updated_at: null })),
  listScenarios: vi.fn(async () => ({ entries: [], total: 0 })),
  addConversation: vi.fn(async (_input: { messages: unknown[] }) => undefined),
  withIsolation: vi.fn(),
};
memoryClient.withIsolation.mockReturnValue(memoryClient);

vi.mock("./client.js", () => ({
  createMemoryClient: () => memoryClient,
}));

import tencentdbMemory from "./index.js";

type Handler = (event: any, ctx: any) => Promise<any> | any;

function setup() {
  const handlers: Record<string, Handler[]> = {};
  const appendEntry = vi.fn();
  const pi = {
    on: (event: string, handler: Handler) => {
      (handlers[event] ??= []).push(handler);
    },
    registerTool: () => undefined,
    appendEntry,
  } as never;
  tencentdbMemory(pi);
  return { appendEntry, handlers };
}

function context(options: {
  abort?: ReturnType<typeof vi.fn>;
  branch?: unknown[];
  entries?: unknown[];
  messages?: unknown[];
} = {}) {
  return {
    abort: options.abort ?? vi.fn(),
    sessionManager: {
      getSessionId: () => "probe-session",
      getEntries: () => options.entries ?? options.branch ?? [],
      getBranch: () => options.branch ?? [],
      buildSessionContext: () => ({ messages: options.messages ?? [] }),
    },
  };
}

describe("tencentdb-memory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memoryClient.withIsolation.mockReturnValue(memoryClient);
    memoryClient.addConversation.mockResolvedValue(undefined);
  });

  it("does not register the removed migration verifier hook", () => {
    const { handlers } = setup();
    expect(handlers.before_provider_request).toBeUndefined();
  });

  it("treats the old probe-shaped text as a normal memory query", async () => {
    const { handlers } = setup();
    const prompt = "[tencentdb-memory-probe:legacy]";

    const result = await handlers.before_agent_start[0](
      { prompt, systemPrompt: "base" },
      context(),
    );

    expect(memoryClient.searchAtomic).toHaveBeenCalledWith({ query: prompt, limit: 5 });
    expect(result.systemPrompt).toContain("persona");
    expect(result.message).toBeUndefined();
  });

  it("captures consecutive identical turns instead of treating the second as a retry", async () => {
    const { handlers } = setup();
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

  it("captures the next turn after compaction shrinks the active message list", async () => {
    const { handlers } = setup();
    const previousMessages = Array.from({ length: 5 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `kept-${index}`,
    }));
    const restoredState = {
      type: "custom",
      customType: "tencentdb-memory-capture",
      data: { cursor: 50, fingerprint: "before-compaction" },
    };
    const ctx = context({ branch: [restoredState], messages: previousMessages });

    await handlers.before_agent_start[0]({ prompt: "new prompt", systemPrompt: "base" }, ctx);
    handlers.agent_end[0](
      {
        messages: [
          ...previousMessages,
          { role: "user", content: "new prompt" },
          { role: "assistant", content: "new answer" },
        ],
      },
      ctx,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(memoryClient.addConversation).toHaveBeenCalledTimes(1);
    expect(memoryClient.addConversation.mock.calls[0][0].messages.map((message: { content: string }) => message.content))
      .toEqual(["new prompt", "new answer"]);
  });

  it("ignores capture state from an abandoned branch", async () => {
    const { handlers } = setup();
    const abandonedState = {
      type: "custom",
      customType: "tencentdb-memory-capture",
      data: { cursor: 50, fingerprint: "abandoned" },
    };
    const prior = [{ role: "assistant", content: "current branch context" }];
    const ctx = context({ entries: [abandonedState], branch: [], messages: prior });

    await handlers.before_agent_start[0]({ prompt: "fork prompt", systemPrompt: "base" }, ctx);
    handlers.agent_end[0](
      {
        messages: [
          ...prior,
          { role: "user", content: "fork prompt" },
          { role: "assistant", content: "fork answer" },
        ],
      },
      ctx,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(memoryClient.addConversation).toHaveBeenCalledTimes(1);
    expect(memoryClient.addConversation.mock.calls[0][0].messages.map((message: { content: string }) => message.content))
      .toEqual(["fork prompt", "fork answer"]);
  });

  it("waits for queued capture when the session shuts down", async () => {
    const { handlers } = setup();
    let finishCapture!: () => void;
    memoryClient.addConversation.mockImplementationOnce(
      () => new Promise<void>((resolve) => { finishCapture = resolve; }),
    );
    const ctx = context();

    await handlers.before_agent_start[0]({ prompt: "last prompt", systemPrompt: "base" }, ctx);
    handlers.agent_end[0](
      { messages: [{ role: "user", content: "last prompt" }, { role: "assistant", content: "last answer" }] },
      ctx,
    );
    let shutdownFinished = false;
    const shutdown = handlers.session_shutdown[0]({}, ctx).then(() => { shutdownFinished = true; });
    await vi.waitFor(() => expect(memoryClient.addConversation).toHaveBeenCalledTimes(1));

    expect(shutdownFinished).toBe(false);
    finishCapture();
    await shutdown;
    expect(shutdownFinished).toBe(true);
  });
});
