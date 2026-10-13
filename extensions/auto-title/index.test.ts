import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import autoTitle, { __resetAutoTitleForTest, subscribeSessionTitleWritten } from "./index.js";

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

function setup(
  entries: Array<{ type?: string; name?: unknown; customType?: string; data?: unknown }> = [],
  options: { sessionFile?: string } = {},
) {
  const handlers = new Map<string, Handler[]>();
  let agentEnd: Handler | undefined;
  const setSessionName = vi.fn(async () => {});
  const appendSessionInfo = vi.fn();
  const pi = {
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      if (event === "agent_end") agentEnd = handler;
    },
    setSessionName,
  };
  autoTitle(pi as unknown as Parameters<typeof autoTitle>[0]);

  const ctx = {
    model: { provider: "chat", id: "main" },
    modelRegistry: {},
    sessionManager: {
      getEntries: () => entries,
      getSessionFile: () => options.sessionFile,
      appendSessionInfo,
    },
    signal: new AbortController().signal,
  };
  const event = { messages: [{ role: "user", content: "Support runtime title toggles" }] };
  const emit = async (name: string, payload: unknown = {}, target: unknown = ctx) => {
    for (const handler of handlers.get(name) ?? []) await handler(payload, target);
  };
  return { agentEnd: agentEnd!, ctx, event, setSessionName, appendSessionInfo, emit };
}

const STALE = "This extension ctx is stale after session replacement or reload.";

const tempDirs: string[] = [];

/** 写回原会话前会检查文件还在：需要落盘的用例用真实文件。 */
function existingSessionFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "auto-title-"));
  tempDirs.push(dir);
  const file = join(dir, "a.jsonl");
  writeFileSync(file, `${JSON.stringify({ type: "session", id: "a" })}\n`);
  return file;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  runtime.autoTitle = undefined;
  delete process.env.PI_IS_SUBAGENT;
  __resetAutoTitleForTest();
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

  it("进程内子代理（会话里有 subagent_meta，没有 PI_IS_SUBAGENT）也跳过", async () => {
    const { agentEnd, ctx, event, setSessionName } = setup([
      { type: "custom", customType: "subagent_meta", data: { origin: "subagent", agentId: "sa-1" } },
    ]);

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

  it("两次都没有标题时不写会话名", async () => {
    mocks.summarize.mockResolvedValue("");
    const { agentEnd, ctx, event, setSessionName } = setup();

    await agentEnd(event, ctx);

    await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(2));
    expect(setSessionName).not.toHaveBeenCalled();
  });

  it("只用提示词和最初的用户指令，并用 maxTokens 限制输出", async () => {
    mocks.summarize.mockResolvedValue("审检查点裁剪规格");
    const { agentEnd, ctx, setSessionName } = setup();
    const instruction = "D:\\OneDrive\\Project Files\\Pi\\docs\\superpowers\\specs\\2026-10-04-context-checkpoint-prune-design.md 审这个规格";

    await agentEnd({ messages: [{ role: "user", content: instruction }] }, ctx);

    await vi.waitFor(() => expect(setSessionName).toHaveBeenCalledWith("审检查点裁剪规格"));
    const userPrompt = String(mocks.summarize.mock.calls[0]?.[1] ?? "");
    const options = mocks.summarize.mock.calls[0]?.[2] as { systemPrompt?: string; maxTokens?: number } | undefined;
    expect(options?.systemPrompt).toContain("You are a professional conversation summarizer");
    expect(options?.systemPrompt).toContain("Reply with only the title");
    expect(options?.maxTokens).toBe(64);
    expect(userPrompt).toBe(
      "<task>\nGenerate a concise title that captures the essence of the conversation.\n</task>\n\n<conversation>\n"
      + `<user>\n${instruction}\n</user>\n</conversation>`,
    );
    expect(userPrompt).not.toContain("assistant");
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

  it("当前会话仍有效时只调用 setSessionName", async () => {
    const notes: Array<string | undefined> = [];
    const unsubscribe = subscribeSessionTitleWritten((file) => notes.push(file));
    const { agentEnd, ctx, event, setSessionName, appendSessionInfo } = setup([], {
      sessionFile: "C:/sessions/a.jsonl",
    });

    await agentEnd(event, ctx);

    await vi.waitFor(() => expect(setSessionName).toHaveBeenCalledWith("Runtime Config Title"));
    expect(appendSessionInfo).not.toHaveBeenCalled();
    expect(notes).toEqual([]);
    unsubscribe();
  });

  it("切换期间被手动命名则不覆盖，也不报 stale", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const notes: Array<string | undefined> = [];
    const unsubscribe = subscribeSessionTitleWritten((file) => notes.push(file));
    const entries: Array<{ type?: string; name?: unknown }> = [];
    let finish!: (value: string) => void;
    mocks.summarize.mockImplementationOnce(
      () => new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    const { agentEnd, ctx, event, setSessionName, appendSessionInfo, emit } = setup(entries, {
      sessionFile: "C:/sessions/a.jsonl",
    });

    await agentEnd(event, ctx);
    await emit("session_shutdown", { type: "session_shutdown", reason: "resume" });
    entries.push({ type: "session_info", name: "Manual Title" });
    finish("Generated Title");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setSessionName).not.toHaveBeenCalled();
    expect(appendSessionInfo).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    expect(notes).toEqual([]);
    unsubscribe();
    spy.mockRestore();
  });

  it("切换会话且没有手动标题时写回原会话文件", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const notes: Array<string | undefined> = [];
    const unsubscribe = subscribeSessionTitleWritten((file) => notes.push(file));
    let finish!: (value: string) => void;
    mocks.summarize.mockImplementationOnce(
      () => new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    const sessionFile = existingSessionFile();
    const { agentEnd, ctx, event, setSessionName, appendSessionInfo, emit } = setup([], { sessionFile });

    await agentEnd(event, ctx);
    await emit("session_shutdown", { type: "session_shutdown", reason: "new" });
    finish("Generated Title");
    await vi.waitFor(() => expect(appendSessionInfo).toHaveBeenCalledWith("Generated Title"));

    expect(setSessionName).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    expect(notes).toEqual([sessionFile]);
    unsubscribe();
    spy.mockRestore();
  });

  it("原会话文件已被删除时不写回，免得重建成只有标题的无头文件", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const notes: Array<string | undefined> = [];
    const unsubscribe = subscribeSessionTitleWritten((file) => notes.push(file));
    let finish!: (value: string) => void;
    mocks.summarize.mockImplementationOnce(
      () => new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    const sessionFile = existingSessionFile();
    const { agentEnd, ctx, event, setSessionName, appendSessionInfo, emit } = setup([], { sessionFile });

    await agentEnd(event, ctx);
    // 删除会话：宿主先把它从 handle 上换走（session_shutdown），再删文件。
    await emit("session_shutdown", { type: "session_shutdown", reason: "new" });
    rmSync(sessionFile);
    finish("Generated Title");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(appendSessionInfo).not.toHaveBeenCalled();
    expect(setSessionName).not.toHaveBeenCalled();
    expect(notes).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    unsubscribe();
    spy.mockRestore();
  });

  it("reload 后由新实例写标题", async () => {
    const notes: Array<string | undefined> = [];
    const unsubscribe = subscribeSessionTitleWritten((file) => notes.push(file));
    let finish!: (value: string) => void;
    mocks.summarize.mockImplementationOnce(
      () => new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    const sessionFile = "C:/sessions/a.jsonl";
    const first = setup([], { sessionFile });
    const second = setup([], { sessionFile });

    await first.agentEnd(first.event, first.ctx);
    await first.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
    finish("Reloaded Title");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first.setSessionName).not.toHaveBeenCalled();
    expect(first.appendSessionInfo).not.toHaveBeenCalled();

    await second.emit("session_start");

    expect(second.setSessionName).toHaveBeenCalledWith("Reloaded Title");
    expect(second.appendSessionInfo).not.toHaveBeenCalled();
    expect(notes).toEqual([]);
    unsubscribe();
  });

  it("reload 的新实例先起来时，标题稍后仍写到新 pi", async () => {
    let finish!: (value: string) => void;
    mocks.summarize.mockImplementationOnce(
      () => new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    const sessionFile = "C:/sessions/a.jsonl";
    const first = setup([], { sessionFile });
    const second = setup([], { sessionFile });

    await first.agentEnd(first.event, first.ctx);
    await first.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
    await second.emit("session_start");
    finish("Reloaded Title");

    await vi.waitFor(() => expect(second.setSessionName).toHaveBeenCalledWith("Reloaded Title"));
    expect(first.setSessionName).not.toHaveBeenCalled();
    expect(first.appendSessionInfo).not.toHaveBeenCalled();
  });

  it("setSessionName 抛出 stale 时改写原会话且不打错误日志", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { agentEnd, ctx, event, setSessionName, appendSessionInfo } = setup([], {
      sessionFile: existingSessionFile(),
    });
    setSessionName.mockImplementation(() => {
      throw new Error(STALE);
    });

    await agentEnd(event, ctx);

    await vi.waitFor(() => expect(appendSessionInfo).toHaveBeenCalledWith("Runtime Config Title"));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("标题模型的其它错误仍然记录", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.summarize.mockRejectedValue(new Error("boom"));
    const { agentEnd, ctx, event, setSessionName, appendSessionInfo } = setup();

    await agentEnd(event, ctx);

    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(setSessionName).not.toHaveBeenCalled();
    expect(appendSessionInfo).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
