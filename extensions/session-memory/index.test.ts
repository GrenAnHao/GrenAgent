import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../_shared/runtime-config.js", () => ({ getConfig: vi.fn() }));
vi.mock("./llm.js", () => ({ askLlm: vi.fn(), resolveModel: vi.fn() }));
vi.mock("./serialize.js", () => ({
  serializeForSummary: (messages: unknown[]) => `SERIALIZED(${messages.length})`,
}));

import { getConfig } from "../_shared/runtime-config.js";
import factory from "./index.js";
import { askLlm, resolveModel } from "./llm.js";
import { readStateDoc, statePath, writeStateDoc } from "./store.js";

type Handler = (event: unknown, ctx: unknown) => unknown;
type Entry = { type: string; id: string; message?: unknown; details?: unknown };

const model = { id: "m" };

beforeEach(() => {
  vi.mocked(getConfig).mockReset().mockImplementation(() => undefined);
  vi.mocked(askLlm).mockReset();
  vi.mocked(resolveModel).mockReset().mockImplementation(() => model as never);
});

function setup() {
  const handlers: Record<string, Handler> = {};
  const commands: string[] = [];
  factory({
    registerCommand: (name: string) => commands.push(name),
    on: (e: string, h: Handler) => {
      handlers[e] = h;
    },
  } as never);
  const cwd = mkdtempSync(join(tmpdir(), "sm-index-"));
  let branch: Entry[] = [];
  const ctx = {
    cwd,
    model,
    modelRegistry: { find: () => undefined },
    sessionManager: { getSessionId: () => "s1", getBranch: () => branch },
    ui: { notify: vi.fn() },
  };
  return {
    handlers,
    commands,
    ctx,
    path: statePath(cwd, "s1"),
    setBranch: (next: Entry[]) => {
      branch = next;
    },
  };
}

const msgEntry = (id: string, content = id): Entry => ({ type: "message", id, message: { role: "user", content } });

const preparation = (over: Record<string, unknown> = {}) => ({
  firstKeptEntryId: "k1",
  tokensBefore: 1234,
  messagesToSummarize: [{ role: "user", content: "old" }],
  turnPrefixMessages: [],
  isSplitTurn: false,
  previousSummary: "PREV-SUMMARY",
  fileOps: { read: new Set(["a.ts"]), edited: new Set(["b.ts"]), written: new Set<string>() },
  settings: {},
  ...over,
});

const beforeCompact = (branchEntries: Entry[], over: Record<string, unknown> = {}) => ({
  type: "session_before_compact",
  preparation: preparation(),
  branchEntries,
  customInstructions: undefined,
  reason: "threshold",
  willRetry: false,
  signal: new AbortController().signal,
  ...over,
});

const userPromptOf = (call: number) => vi.mocked(askLlm).mock.calls[call][2] as string;

describe("session-memory factory", () => {
  it("registers state hooks and /session-state command", () => {
    const { handlers, commands } = setup();
    expect(commands).toContain("session-state");
    expect(Object.keys(handlers)).toEqual(
      expect.arrayContaining(["turn_end", "agent_end", "session_before_compact", "session_compact", "before_agent_start"]),
    );
  });
});

describe("session_before_compact 用状态当摘要", () => {
  it("抽取成功：返回压缩结果，状态文件写入同一正文并带锚点", async () => {
    const { handlers, ctx, path } = setup();
    const branch = [msgEntry("e1"), msgEntry("e2")];
    writeStateDoc(path, "## Intent\n- prev", "e1");
    vi.mocked(askLlm).mockResolvedValue("## Intent\n- new");
    const event = beforeCompact(branch);

    const result = (await handlers.session_before_compact(event, ctx)) as {
      compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: unknown };
    };

    expect(result.compaction.firstKeptEntryId).toBe("k1");
    expect(result.compaction.tokensBefore).toBe(1234);
    expect(result.compaction.details).toEqual({ source: "session-state", readFiles: ["a.ts"], modifiedFiles: ["b.ts"] });
    expect(result.compaction.summary).toBe(
      "## Intent\n- new\n\n<read-files>\na.ts\n</read-files>\n\n<modified-files>\nb.ts\n</modified-files>",
    );
    expect(readStateDoc(path)).toEqual({ body: "## Intent\n- new", anchor: "e2" });

    const prompt = userPromptOf(0);
    expect(prompt).toContain("<previous-state>\n## Intent\n- prev\n</previous-state>");
    expect(prompt).toContain("<previous-summary>\nPREV-SUMMARY\n</previous-summary>");
    expect(prompt).toContain("<conversation>\nSERIALIZED(1)\n</conversation>");
    expect(prompt).not.toContain("<current-turn-prefix>");
    expect(vi.mocked(askLlm).mock.calls[0][3]).toBe(event.signal);
  });

  it("锚点不在当前分支时不带上一份状态", async () => {
    const { handlers, ctx, path } = setup();
    writeStateDoc(path, "## Intent\n- other branch", "gone");
    vi.mocked(askLlm).mockResolvedValue("## Intent\n- new");
    await handlers.session_before_compact(beforeCompact([msgEntry("e1")]), ctx);
    expect(userPromptOf(0)).not.toContain("other branch");
  });

  it("切在一轮中间时带上切轮前缀", async () => {
    const { handlers, ctx } = setup();
    vi.mocked(askLlm).mockResolvedValue("## Intent\n- new");
    const event = beforeCompact([msgEntry("e1")], {
      preparation: preparation({
        isSplitTurn: true,
        turnPrefixMessages: [{ role: "user", content: "p1" }, { role: "assistant", content: [] }],
      }),
    });
    await handlers.session_before_compact(event, ctx);
    expect(userPromptOf(0)).toContain("<current-turn-prefix>\nSERIALIZED(2)\n</current-turn-prefix>");
  });

  it("合并上一份 session-state 压缩条目的文件列表", async () => {
    const { handlers, ctx } = setup();
    vi.mocked(askLlm).mockResolvedValue("## Intent\n- new");
    const branch: Entry[] = [
      msgEntry("e1"),
      { type: "compaction", id: "c1", details: { source: "session-state", readFiles: ["z.ts"], modifiedFiles: ["y.ts"] } },
      msgEntry("e2"),
    ];
    const result = (await handlers.session_before_compact(beforeCompact(branch), ctx)) as {
      compaction: { details: unknown };
    };
    expect(result.compaction.details).toEqual({
      source: "session-state",
      readFiles: ["a.ts", "z.ts"],
      modifiedFiles: ["b.ts", "y.ts"],
    });
  });

  it("抽取抛错或输出为空时交给 Pi，状态文件不变", async () => {
    const { handlers, ctx, path } = setup();
    writeStateDoc(path, "## Intent\n- prev", "e1");
    vi.mocked(askLlm).mockRejectedValueOnce(new Error("overflow")).mockResolvedValueOnce("   ");
    expect(await handlers.session_before_compact(beforeCompact([msgEntry("e1")]), ctx)).toBeUndefined();
    expect(await handlers.session_before_compact(beforeCompact([msgEntry("e1")]), ctx)).toBeUndefined();
    expect(readStateDoc(path)).toEqual({ body: "## Intent\n- prev", anchor: "e1" });
  });

  it("信号已中止时交给 Pi", async () => {
    const { handlers, ctx, path } = setup();
    const controller = new AbortController();
    controller.abort();
    vi.mocked(askLlm).mockResolvedValue("## Intent\n- new");
    const result = await handlers.session_before_compact(
      beforeCompact([msgEntry("e1")], { signal: controller.signal }),
      ctx,
    );
    expect(result).toBeUndefined();
    expect(readStateDoc(path)).toBeUndefined();
  });

  it("解析不到模型或功能关闭时交给 Pi，不调模型", async () => {
    const { handlers, ctx } = setup();
    vi.mocked(resolveModel).mockImplementation(() => undefined);
    expect(await handlers.session_before_compact(beforeCompact([msgEntry("e1")]), ctx)).toBeUndefined();

    vi.mocked(resolveModel).mockImplementation(() => model as never);
    vi.mocked(getConfig).mockImplementation((name: string) => (name === "SESSION_STATE_ENABLED" ? "0" : undefined));
    expect(await handlers.session_before_compact(beforeCompact([msgEntry("e1")]), ctx)).toBeUndefined();
    expect(askLlm).not.toHaveBeenCalled();
  });

  it("customInstructions 非空时交给 Pi，但按旧方式刷新状态", async () => {
    const { handlers, ctx, path } = setup();
    vi.mocked(askLlm).mockResolvedValue("## Intent\n- refreshed");
    const result = await handlers.session_before_compact(
      beforeCompact([msgEntry("e1", "hello"), msgEntry("e2", "world")], { customInstructions: "focus" }),
      ctx,
    );
    expect(result).toBeUndefined();
    expect(userPromptOf(0)).toContain("user: world");
    expect(readStateDoc(path)).toEqual({ body: "## Intent\n- refreshed", anchor: "e2" });
  });

  it("先开始的周期写入晚于压缩写入完成时，不覆盖压缩结果", async () => {
    const { handlers, ctx, path, setBranch } = setup();
    vi.mocked(getConfig).mockImplementation((name: string) => (name === "SESSION_STATE_EVERY_TURNS" ? "1" : undefined));
    setBranch([msgEntry("e1")]);
    let releaseStale: (v: string) => void = () => {};
    vi.mocked(askLlm)
      .mockImplementationOnce(() => new Promise<string>((resolve) => (releaseStale = resolve)))
      .mockResolvedValueOnce("## Intent\n- compaction");

    await handlers.turn_end({}, ctx);
    await handlers.agent_end({ messages: [{ role: "user", content: "x" }] }, ctx);
    await handlers.session_before_compact(beforeCompact([msgEntry("e1"), msgEntry("e2")]), ctx);
    releaseStale("## Intent\n- stale");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(readStateDoc(path)?.body).toBe("## Intent\n- compaction");
  });
});

describe("压缩后是否注入", () => {
  it("摘要来自状态时不注入，Pi 写的摘要照旧注入，锚点不在分支上时不注入", async () => {
    const { handlers, ctx, path, setBranch } = setup();
    setBranch([msgEntry("e1"), msgEntry("e2")]);
    writeStateDoc(path, "## Intent\n- state", "e2");

    await handlers.session_compact(
      { fromExtension: true, compactionEntry: { details: { source: "session-state" } } },
      ctx,
    );
    expect(await handlers.before_agent_start({}, ctx)).toBeUndefined();

    await handlers.session_compact({ fromExtension: false, compactionEntry: { details: {} } }, ctx);
    const injected = (await handlers.before_agent_start({}, ctx)) as { message: { content: string } };
    expect(injected.message.content).toContain("## Intent\n- state");
    expect(injected.message.content).not.toContain("anchor=");

    setBranch([msgEntry("e1")]);
    await handlers.session_compact({ fromExtension: false, compactionEntry: { details: {} } }, ctx);
    expect(await handlers.before_agent_start({}, ctx)).toBeUndefined();
  });
});
