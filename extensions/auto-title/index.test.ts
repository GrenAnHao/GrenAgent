import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ autoTitle: undefined as string | undefined }));
const mocks = vi.hoisted(() => ({
  summarize: vi.fn<(...args: unknown[]) => Promise<string>>(),
  resolveSummaryModel: vi.fn<() => { provider: string; id: string } | undefined>(),
}));

vi.mock("../_shared/runtime-config.js", () => ({
  getConfig: vi.fn((key: string) => (key === "AUTO_TITLE" ? runtime.autoTitle : undefined)),
}));
vi.mock("../_shared/summarize.js", () => ({
  resolveSummaryModel: mocks.resolveSummaryModel,
  summarize: mocks.summarize,
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
    model: { provider: "chat", id: "main" },
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
  mocks.summarize.mockReset().mockResolvedValue("Runtime Config Title");
  mocks.resolveSummaryModel.mockReset().mockReturnValue({ provider: "title", id: "fast" });
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

  it("标题模型返回空内容时回退当前对话模型", async () => {
    const { agentEnd, ctx, event, setSessionName } = setup();
    mocks.summarize.mockResolvedValueOnce("").mockResolvedValueOnce("Fallback Title");

    await agentEnd(event, ctx);

    await vi.waitFor(() => expect(setSessionName).toHaveBeenCalledWith("Fallback Title"));
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(mocks.summarize.mock.calls[1]?.[2]).toMatchObject({ modelSpec: "chat/main" });
  });

  it("标题模型抛错时回退当前对话模型", async () => {
    const { agentEnd, ctx, event, setSessionName } = setup();
    mocks.summarize.mockRejectedValueOnce(new Error("title failed")).mockResolvedValueOnce("Fallback Title");

    await agentEnd(event, ctx);

    await vi.waitFor(() => expect(setSessionName).toHaveBeenCalledWith("Fallback Title"));
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it("标题模型就是当前对话模型时不重复调用", async () => {
    mocks.resolveSummaryModel.mockReturnValue({ provider: "chat", id: "main" });
    mocks.summarize.mockResolvedValue("");
    const { agentEnd, ctx, event, setSessionName } = setup();

    await agentEnd(event, ctx);

    await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(1));
    expect(setSessionName).not.toHaveBeenCalled();
  });

  it("回退也失败时不写标题", async () => {
    mocks.summarize.mockResolvedValue("");
    const { agentEnd, ctx, event, setSessionName } = setup();

    await agentEnd(event, ctx);

    await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(2));
    expect(setSessionName).not.toHaveBeenCalled();
  });

  it("生成期间出现手动标题时不覆盖", async () => {
    const entries: Array<{ type?: string; name?: unknown }> = [];
    let finish!: (value: string) => void;
    mocks.summarize.mockImplementationOnce(
      () => new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    const { agentEnd, ctx, event, setSessionName } = setup(entries);

    await agentEnd(event, ctx);
    await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(1));
    entries.push({ type: "session_info", name: "Manual Title" });
    finish("Generated Title");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setSessionName).not.toHaveBeenCalled();
  });
});
