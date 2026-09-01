import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ autoTitle: undefined as string | undefined }));

vi.mock("../_shared/runtime-config.js", () => ({
  getConfig: vi.fn((key: string) => (key === "AUTO_TITLE" ? runtime.autoTitle : undefined)),
}));
vi.mock("../_shared/summarize.js", () => ({
  resolveSummaryModel: vi.fn(() => ({})),
  summarize: vi.fn(async () => "Runtime Config Title"),
}));

import { resolveSummaryModel, summarize } from "../_shared/summarize.js";
import autoTitle from "./index.js";

type AgentEndHandler = (event: unknown, ctx: unknown) => Promise<void>;

function setup(entries: Array<{ type?: string; name?: unknown }> = []) {
  let agentEnd: AgentEndHandler | undefined;
  const setSessionName = vi.fn(async () => {});
  const pi = {
    on: (event: string, handler: AgentEndHandler) => {
      if (event === "agent_end") agentEnd = handler;
    },
    setSessionName,
  };
  autoTitle(pi as unknown as Parameters<typeof autoTitle>[0]);

  const ctx = {
    model: {},
    modelRegistry: {},
    sessionManager: { getEntries: () => entries },
    signal: new AbortController().signal,
  };
  const event = { messages: [{ role: "user", content: "Support runtime title toggles" }] };
  return { agentEnd: agentEnd!, ctx, event, setSessionName };
}

beforeEach(() => {
  runtime.autoTitle = undefined;
  delete process.env.PI_IS_SUBAGENT;
  vi.clearAllMocks();
});

describe("auto-title", () => {
  it("默认启用，并在同一扩展实例中热更新 AUTO_TITLE=0", async () => {
    const { agentEnd, ctx, event, setSessionName } = setup();

    await agentEnd(event, ctx);
    await vi.waitFor(() => {
      expect(summarize).toHaveBeenCalledTimes(1);
      expect(setSessionName).toHaveBeenCalledWith("Runtime Config Title");
    });

    runtime.autoTitle = "0";
    await agentEnd(event, ctx);

    await vi.waitFor(() => {
      expect(summarize).toHaveBeenCalledTimes(1);
      expect(setSessionName).toHaveBeenCalledTimes(1);
    });
  });

  it("PI_IS_SUBAGENT=1 时跳过", async () => {
    process.env.PI_IS_SUBAGENT = "1";
    const { agentEnd, ctx, event, setSessionName } = setup();

    await agentEnd(event, ctx);

    expect(resolveSummaryModel).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
    expect(setSessionName).not.toHaveBeenCalled();
  });

  it("已有非空 session_info.name 时跳过", async () => {
    const { agentEnd, ctx, event, setSessionName } = setup([
      { type: "session_info", name: "Existing Title" },
    ]);

    await agentEnd(event, ctx);

    expect(resolveSummaryModel).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
    expect(setSessionName).not.toHaveBeenCalled();
  });
});
