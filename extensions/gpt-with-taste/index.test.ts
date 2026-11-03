import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import factory, { COMPLETED_RESULT_TYPES, formatStatus, roleFromEnv, statusOf } from "./index.js";
import { ensurePayloadInstructions } from "./payload.js";
import { projectMessages, TASTE_SECTION, TASTE_STEER_TYPE, type ProjectedMessage } from "./projection.js";
import { loadTasteTexts, tasteTextsDir, TASTE_TEXT_FILES, __resetTasteTextsForTest } from "./texts.js";
import { readTasteState, tasteApplies, TASTE_STATE_TYPE } from "../_shared/taste-scope.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

const TEXTS = loadTasteTexts();
if (!TEXTS) throw new Error("taste texts missing: " + tasteTextsDir());

const gpt = (id = "gpt-6.1-sol") => ({ provider: "custom-mvrhmv0y", id, api: "openai-responses" });
const claude = () => ({ provider: "custom-muqywnc8", id: "claude-opus-5", api: "anthropic-messages" });

function makePi() {
  const handlers: Record<string, Handler> = {};
  const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
  const entries: Array<{ type: string; customType: string; data?: unknown }> = [];
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers[event] = handler;
    },
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands[name] = options;
    },
    appendEntry: (customType: string, data?: unknown) => {
      entries.push({ type: "custom", customType, data });
    },
  };
  return { pi, handlers, commands, entries };
}

function ctx(model: unknown = gpt(), branch: Array<{ type: string; customType: string; data?: unknown }> = []) {
  return {
    model,
    sessionManager: {
      getBranch: () => branch,
      getEntries: () => branch,
    },
    ui: { notify: vi.fn(), setStatus: vi.fn() },
  };
}

const systemMessages = (content = "base prompt"): ProjectedMessage[] => [
  {
    role: "system",
    content: "",
    sections: { preamble: `<preamble>\n${content}\n</preamble>` },
    timestamp: 1,
  },
];

const sys = (messages: ProjectedMessage[]): ProjectedMessage => messages[0];

const steers = (messages: ProjectedMessage[]) =>
  messages.filter((message) => message.customType === TASTE_STEER_TYPE);

afterEach(() => {
  delete process.env.GPT_WITH_TASTE;
  delete process.env.GPT_WITH_TASTE_MODEL_PATTERN;
  delete process.env.GPT_WITH_TASTE_ROLE;
  delete process.env.PI_IS_SUBAGENT;
});

describe("taste text assets", () => {
  it("loads all six recipe texts from texts/", () => {
    expect(Object.keys(TASTE_TEXT_FILES)).toHaveLength(6);
    for (const key of Object.keys(TASTE_TEXT_FILES) as Array<keyof typeof TASTE_TEXT_FILES>) {
      expect(TEXTS[key].length).toBeGreaterThan(100);
    }
    expect(TEXTS.main).toContain("GPT with Taste");
  });

  it("caches by directory and returns undefined instead of throwing when a file is missing", () => {
    __resetTasteTextsForTest();
    expect(loadTasteTexts("D:/definitely-not-here")).toBeUndefined();
    const first = loadTasteTexts();
    expect(loadTasteTexts()).toBe(first);
  });
});

describe("projection", () => {
  const options = { role: "main" as const, active: true, steering: true, completedResultTypes: new Set(COMPLETED_RESULT_TYPES) };

  it("attaches the block to the leading system message as its own section", () => {
    const out = projectMessages(systemMessages(), TEXTS, options);
    expect(sys(out).sections?.[TASTE_SECTION]).toContain("<gpt-with-taste>");
    expect(sys(out).sections?.preamble).toContain("base prompt");
    expect(out).toHaveLength(1);
  });

  it("leaves the transcript untouched when inactive, but strips a previous projection", () => {
    const projected = projectMessages(systemMessages(), TEXTS, options);
    const off = projectMessages(projected, TEXTS, { ...options, active: false });
    expect(sys(off).sections).not.toHaveProperty(TASTE_SECTION);
    expect(sys(off).sections?.preamble).toContain("base prompt");
  });

  it("does not stack steer messages when the same array is projected twice", () => {
    const history = [
      ...systemMessages(),
      { role: "assistant", content: "done", timestamp: 2 },
      { role: "user", content: "next", timestamp: 3 },
    ];
    const once = projectMessages(history, TEXTS, options);
    const twice = projectMessages(once, TEXTS, options);
    expect(steers(once)).toHaveLength(1);
    expect(steers(twice)).toHaveLength(1);
  });

  it("only reminds after the last assistant message, not for old inputs", () => {
    const history = [
      ...systemMessages(),
      { role: "user", content: "old", timestamp: 2 },
      { role: "assistant", content: "answer", timestamp: 3 },
      { role: "user", content: "new", timestamp: 4 },
    ];
    const out = projectMessages(history, TEXTS, options);
    const found = steers(out);
    expect(found).toHaveLength(1);
    expect(out.indexOf(found[0])).toBe(out.indexOf(history[3]) + 1);
    expect(String(found[0].content)).toContain("gpt-with-taste-user-steer");
    expect(found[0].display).toBe(false);
  });

  it("routes sub sessions to the sub steer and completed collaborator results to agent steer", () => {
    const history = [
      ...systemMessages(),
      { role: "assistant", content: "answer", timestamp: 3 },
      { role: "custom", customType: "subagent-settled", content: "child done", timestamp: 4 },
      { role: "user", content: "next", timestamp: 5 },
    ];
    const main = projectMessages(history, TEXTS, options);
    expect(steers(main).map((m) => (m.details as { route?: string } | undefined)?.route)).toEqual(["agent", "user"]);

    const sub = projectMessages(history, TEXTS, { ...options, role: "sub" });
    expect(steers(sub).map((m) => (m.details as { route?: string } | undefined)?.route)).toEqual(["sub"]);
    expect(sys(sub).sections?.[TASTE_SECTION]).toContain(TEXTS.sub.trim().slice(0, 40));

    const independent = projectMessages(history, TEXTS, { ...options, role: "independent" });
    expect(steers(independent)).toHaveLength(0);
  });

  it("skips reminders when steering is off but keeps the block", () => {
    const history = [...systemMessages(), { role: "user", content: "hi", timestamp: 2 }];
    const out = projectMessages(history, TEXTS, { ...options, steering: false });
    expect(steers(out)).toHaveLength(0);
    expect(sys(out).sections?.[TASTE_SECTION]).toBeDefined();
  });

  it("refuses to invent a leading system message", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = projectMessages([{ role: "user", content: "hi", timestamp: 1 }], TEXTS, options);
    expect(out).toHaveLength(1);
    spy.mockRestore();
  });
});

describe("payload guard", () => {
  const block = "<gpt-with-taste>\nX\n</gpt-with-taste>";

  it("appends to Responses instructions and stays idempotent", () => {
    const payload = { model: "gpt-6.1-sol", instructions: "host", input: [] };
    const once = ensurePayloadInstructions(payload, block);
    expect(once.supported).toBe(true);
    expect((once.payload as { instructions: string }).instructions).toBe(`host\n\n${block}`);
    const twice = ensurePayloadInstructions(once.payload, block);
    expect(twice.payload).toBe(once.payload);
  });

  it("appends to an Anthropic system field without touching messages", () => {
    const payload = { model: "claude", system: "host", messages: [{ role: "user", content: "hi" }] };
    const out = ensurePayloadInstructions(payload, block);
    expect(out.supported).toBe(true);
    expect((out.payload as { system: string }).system).toBe(`host\n\n${block}`);
    expect((out.payload as { messages: unknown[] }).messages).toBe(payload.messages);
  });

  it("appends to a Chat Completions system message", () => {
    const payload = {
      model: "gpt-x",
      messages: [
        { role: "system", content: [{ type: "text", text: "host" }] },
        { role: "user", content: "hi" },
      ],
    };
    const out = ensurePayloadInstructions(payload, block);
    expect(out.supported).toBe(true);
    const messages = (out.payload as { messages: Array<{ content: unknown }> }).messages;
    expect(messages[0].content).toEqual([
      { type: "text", text: "host" },
      { type: "text", text: block },
    ]);
    expect(messages[1]).toBe(payload.messages[1]);
  });

  it("reports unsupported for unknown shapes instead of guessing", () => {
    expect(ensurePayloadInstructions({ model: "x" }, block).supported).toBe(false);
    expect(ensurePayloadInstructions(null, block).supported).toBe(false);
    expect(ensurePayloadInstructions({ model: "x", instructions: { bad: true }, input: [] }, block).supported).toBe(false);
  });
});

describe("scope", () => {
  it("defaults to gpt-* models on any provider", () => {
    expect(tasteApplies({ model: gpt() })).toBe(true);
    expect(tasteApplies({ model: claude() })).toBe(false);
    expect(tasteApplies({ model: undefined })).toBe(false);
  });

  it("honours GPT_WITH_TASTE=0 and a custom model pattern", () => {
    process.env.GPT_WITH_TASTE = "0";
    expect(tasteApplies({ model: gpt() })).toBe(false);
    delete process.env.GPT_WITH_TASTE;
    process.env.GPT_WITH_TASTE_MODEL_PATTERN = "^claude-opus";
    expect(tasteApplies({ model: claude() })).toBe(true);
    expect(tasteApplies({ model: gpt() })).toBe(false);
  });

  it("reads the latest branch state and lets /taste off disable the layer", () => {
    const entries = [
      { type: "custom" as const, customType: TASTE_STATE_TYPE, data: { enabled: false } },
      { type: "custom" as const, customType: TASTE_STATE_TYPE, data: { enabled: true, steering: false } },
    ];
    expect(readTasteState(entries)).toEqual({ enabled: true, steering: false });
    expect(tasteApplies({ model: gpt(), entries })).toBe(true);
    expect(tasteApplies({ model: gpt(), entries: [entries[0]] })).toBe(false);
    expect(readTasteState(undefined)).toEqual({});
  });
});

describe("extension wiring", () => {
  it("projects the block on context_with_system for a gpt model", async () => {
    const { pi, handlers } = makePi();
    factory(pi as never);
    const session = ctx();
    const out = (await handlers.context_with_system(
      { type: "context_with_system", messages: systemMessages() },
      session,
    )) as { messages: Array<{ sections?: Record<string, string> }> };
    expect(out.messages[0].sections?.[TASTE_SECTION]).toContain("<gpt-with-taste>");
  });

  it("does nothing for a claude model", async () => {
    const { pi, handlers } = makePi();
    factory(pi as never);
    const out = (await handlers.context_with_system(
      { type: "context_with_system", messages: systemMessages() },
      ctx(claude()),
    )) as { messages: Array<{ sections?: Record<string, string> }> } | undefined;
    expect(out?.messages[0].sections?.[TASTE_SECTION]).toBeUndefined();
  });

  it("guards the final payload only inside scope", async () => {
    const { pi, handlers } = makePi();
    factory(pi as never);
    const payload = { model: "gpt-6.1-sol", instructions: "host", input: [] };
    const guarded = (await handlers.before_provider_request({ type: "before_provider_request", payload }, ctx())) as {
      instructions: string;
    };
    expect(guarded.instructions).toContain("<gpt-with-taste>");

    const skipped = await handlers.before_provider_request(
      { type: "before_provider_request", payload },
      ctx(claude()),
    );
    expect(skipped).toBeUndefined();
  });

  it("warns once when the payload format is unknown", async () => {
    const { pi, handlers } = makePi();
    factory(pi as never);
    const session = ctx();
    const event = { type: "before_provider_request", payload: { model: "gpt-6.1-sol" } };
    await handlers.before_provider_request(event, session);
    await handlers.before_provider_request(event, session);
    expect((session.ui.notify as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("persists /taste state on the branch and reports it", async () => {
    const { pi, commands, entries } = makePi();
    factory(pi as never);
    // 分支就是 appendEntry 写进去的那个数组，模拟真实 session manager 的读回。
    const session = ctx(gpt(), entries);
    await commands.taste.handler("off", session);
    expect(entries.at(-1)).toEqual({ type: "custom", customType: TASTE_STATE_TYPE, data: { enabled: false } });
    const message = String((session.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]);
    expect(message).toContain("生效：否");

    await commands.taste.handler("steer off", session);
    expect(entries.at(-1)?.data).toEqual({ enabled: false, steering: false });

    await commands.taste.handler("reset", session);
    expect(entries.at(-1)?.data).toEqual({});

    await commands.taste.handler("bogus", session);
    expect(String((session.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0])).toContain("用法");
  });

  it("uses the Sub role for subagent sessions", async () => {
    const { pi, handlers } = makePi();
    factory(pi as never);
    const branch = [{ type: "custom", customType: "subagent_meta", data: {} }];
    const out = (await handlers.context_with_system(
      { type: "context_with_system", messages: [...systemMessages(), { role: "user", content: "go", timestamp: 5 }] },
      ctx(gpt(), branch),
    )) as { messages: Array<{ customType?: string; content?: unknown; sections?: Record<string, string> }> };
    expect(out.messages[0].sections?.[TASTE_SECTION]).toContain(TEXTS.sub.trim().slice(0, 40));
    expect(String(out.messages.at(-1)?.content)).toContain("gpt-with-taste-sub-steer");
  });

  it("lets GPT_WITH_TASTE_ROLE override the inferred role", () => {
    process.env.GPT_WITH_TASTE_ROLE = "independent";
    expect(roleFromEnv()).toBe("independent");
    process.env.GPT_WITH_TASTE_ROLE = "nonsense";
    expect(roleFromEnv()).toBeUndefined();
  });

  it("formats a status line that names the model and the reason for inactivity", () => {
    const status = statusOf(ctx(claude()) as never, []);
    const text = formatStatus(status);
    expect(text).toContain("角色 main");
    expect(text).toContain("生效：否");
    expect(text).toContain("claude-opus-5");
    expect(text).toContain("未生效");
  });
});

describe("vendored texts stay attributable", () => {
  it("keeps the upstream MIT license next to the texts", () => {
    const license = readFileSync(join(tasteTextsDir(), "..", "LICENSE"), "utf8");
    expect(license).toContain("MIT License");
    expect(license).toContain("GPT with Taste contributors");
  });
});
