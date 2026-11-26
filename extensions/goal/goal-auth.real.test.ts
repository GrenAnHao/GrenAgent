// Real SDK + faux transport. The extension is dynamically loaded by SDK/jiti from a
// temporary TS-only overlay: ignored .js/.d.ts files in the working tree are not consulted.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pi-goal-auth-agent-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
});
import { createAgentSessionFromServices, createAgentSessionServices, createCodemodeExtension, ModelRuntime, resolveCliModel, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { beginCompactionIntent, observeCompactionEvent } from "../_shared/compaction-activity.js";
import { controlGoal } from "./control.js";
import { buildGoalStatus } from "./status.js";

const sourceDir = dirname(import.meta.filename);
const overlay = mkdtempSync(join(dirname(sourceDir), ".goal-source-"));
function copySourceFolder(name: "goal" | "_shared" | "agent-mode" | "visual-companion") {
  cpSync(join(sourceDir, "..", name), join(overlay, name), {
    recursive: true,
    filter: (path) => !/\.(?:js|mjs|cjs|map|test\.ts|real\.test\.ts|d\.ts)$/.test(path),
  });
}

describe("Goal immutable tool-call attribution (real SDK, TS-only jiti extension)", () => {
  const ws = mkdtempSync(join(tmpdir(), "pi-goal-auth-ws-"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  let runtime: ModelRuntime;
  const statuses: Array<Record<string, any>> = [];
  const recordedSequences: Array<{ label: string; goalEvents: unknown[]; sdkEvents: unknown[] }> = [];
  beforeAll(async () => {
    mkdirSync(join(home, "sessions"), { recursive: true });
    copySourceFolder("goal"); copySourceFolder("_shared"); copySourceFolder("agent-mode"); copySourceFolder("visual-companion");
    runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
  });
  afterAll(() => {
    writeFileSync(join(sourceDir, "..", "..", ".agents", "evidence", "2026-11-17-visual-review-and-goal-lifecycle", "goal-sdk-event-sequences.json"),
      JSON.stringify(recordedSequences, null, 2) + "\n");
    rmSync(overlay, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  async function sessionWith(respond: Parameters<typeof faux.setResponses>[0], extraFactories: unknown[] = [], options: {
    visualReview?: boolean;
    input?: (payload: string, placeholder: unknown, opts: { signal?: AbortSignal }) => Promise<string | undefined>;
    visualStatus?: (value: { previewId: string; mode: string }) => void;
  } = {}) {
    statuses.length = 0;
    faux.setResponses(respond);
    const services = await createAgentSessionServices({
      cwd: ws, agentDir: home, modelRuntime: runtime,
      resourceLoaderOptions: {
        additionalExtensionPaths: [join(overlay, "goal", "index.ts"),
          ...(options.visualReview ? [join(overlay, "visual-companion", "index.ts"), join(overlay, "agent-mode", "index.ts")] : [])],
        extensionFactories: [...extraFactories, createCodemodeExtension()] as never, noExtensions: true, noContextFiles: true,
      },
    });
    const model = resolveCliModel({ cliModel: "faux/faux-1", modelRuntime: services.modelRuntime }).model;
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(ws), model });
    await session.bindExtensions({ uiContext: { notify: () => {}, setStatus: (key: string, text?: string) => {
      if (key === "goal" && text) statuses.push(JSON.parse(text));
      if (key === "visual" && text) options.visualStatus?.(JSON.parse(text));
    }, input: options.input ?? (async () => undefined) } as never });
    session.setActiveToolsByName([...new Set([...session.getActiveToolNames(), "codemode", "update_goal",
      ...(options.visualReview ? ["show_visual", "ask_user"] : [])])]);
    return session;
  }

  function logGoalSequence(label: string, session: Awaited<ReturnType<typeof sessionWith>>, sdkEvents: unknown[] = []) {
    const goalEvents = session.sessionManager.getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === "goal")
      .map((entry) => (entry as { data: unknown }).data);
    recordedSequences.push({ label, goalEvents, sdkEvents });
  }

  it("loads current TS (batch fields), authorizes direct call at the real preflight boundary", async () => {
    let goalId = "";
    const session = await sessionWith([
      () => {
        const goal = statuses.at(-1)?.snapshot;
        goalId = goal.goalId;
        return fauxAssistantMessage(fauxToolCall("update_goal", { goalId, revision: goal.revision, action: "complete" }));
      },
      fauxAssistantMessage(fauxText("done")),
    ] as never);
    try {
      await session.prompt("/goal finish task", { source: "rpc" } as never);
      await session.waitForIdle();
      const entries = session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "goal");
      const kinds = entries.map((entry) => (entry as { data: { kind: string } }).data.kind);
      expect(kinds).toContain("complete");
      expect(statuses.at(-1)?.snapshot).toMatchObject({ goalId, runNumber: 1, runRoundsStarted: 1, conditionRevision: 1, status: "complete" });
      expect(kinds.filter((kind) => kind === "round")).toHaveLength(1);
    } finally { session.dispose(); }
  }, 30_000);

  it("a direct call returns CAS conflict after same-condition edit, then accepts a refreshed revision on the original round", async () => {
    let release: () => void = () => {};
    let reached = false;
    const delay = (pi: { on: (name: string, callback: (event: { toolName: string }) => Promise<void>) => void }) => {
      pi.on("tool_call", async (event) => {
        if (event.toolName !== "update_goal" || reached) return;
        await new Promise<void>((resolve) => { release = resolve; reached = true; });
      });
    };
    statuses.length = 0;
    faux.setResponses([
      () => {
        const goal = statuses.at(-1)!.snapshot;
        return fauxAssistantMessage(fauxToolCall("update_goal", { goalId: goal.goalId, revision: goal.revision, action: "complete" }));
      },
      () => {
        const goal = statuses.at(-1)!.snapshot;
        return fauxAssistantMessage(fauxToolCall("update_goal", { goalId: goal.goalId, revision: goal.revision, action: "complete" }));
      },
      fauxAssistantMessage(fauxText("finished")),
    ]);
    const services = await createAgentSessionServices({ cwd: ws, agentDir: home, modelRuntime: runtime,
      resourceLoaderOptions: { additionalExtensionPaths: [join(overlay, "goal", "index.ts")], extensionFactories: [delay as never], noExtensions: true, noContextFiles: true },
    });
    const model = resolveCliModel({ cliModel: "faux/faux-1", modelRuntime: services.modelRuntime }).model;
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(ws), model });
    await session.bindExtensions({ uiContext: { notify: () => {}, setStatus: (key: string, text?: string) => {
      if (key === "goal" && text) statuses.push(JSON.parse(text));
    } } as never });
    try {
      await session.prompt("/goal same", { source: "rpc" } as never);
      await vi.waitUntil(() => reached, { timeout: 6000 });
      await session.prompt("/goal edit same", { source: "rpc" } as never);
      release();
      await session.waitForIdle();
      const results = session.messages.filter((message) => message.role === "toolResult" && message.toolName === "update_goal");
      expect(JSON.stringify(results[0])).toContain("VERSION_CONFLICT");
      expect(results).toHaveLength(2);
      expect(statuses.at(-1)?.snapshot).toMatchObject({ status: "complete", conditionRevision: 1 });
    } finally { release(); session.dispose(); }
  }, 30_000);

  it("honors the SDK's final retry outcome, not a transient agent_end error", async () => {
    let release: () => void = () => {};
    let reached = false;
    const gate = (pi: { registerTool: (tool: unknown) => void }) => pi.registerTool({
      name: "retry_gate", label: "Gate", description: "Hold the recovered Goal round.", promptSnippet: "Hold a round.",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => {
        await new Promise<void>((resolve) => { release = resolve; reached = true; });
        return { content: [{ type: "text", text: "released" }], details: {} };
      },
    });
    const session = await sessionWith([
      fauxAssistantMessage(fauxText("temporary"), { stopReason: "error", errorMessage: "503 server error" }),
      fauxAssistantMessage(fauxText("recovered")),
      fauxAssistantMessage(fauxToolCall("retry_gate", {})),
      fauxAssistantMessage(fauxText("done")),
    ], [gate]);
    (session.settingsManager as never as { getRetrySettings: () => unknown }).getRetrySettings = () => ({ enabled: true, maxRetries: 1, baseDelayMs: 0, maxAgentDelayMs: 0 });
    try {
      await session.prompt("/goal retry-work", { source: "rpc" } as never);
      await vi.waitUntil(() => reached, { timeout: 8000 }).catch(() => { throw new Error(`retry did not reach next round: ${JSON.stringify(statuses.map((item) => item.snapshot))}`); });
      expect(statuses.at(-1)?.snapshot).toMatchObject({ status: "active", runRoundsStarted: 2 });
      await session.prompt("/goal pause", { source: "rpc" } as never);
      release();
      await session.waitForIdle();
      expect(statuses.at(-1)?.snapshot).toMatchObject({ status: "paused", pauseReason: { code: "user" } });
    } finally { release(); session.dispose(); }
  }, 30_000);

  it("pauses after the SDK exhausts retries without creating another round", async () => {
    const session = await sessionWith([
      fauxAssistantMessage(fauxText("first"), { stopReason: "error", errorMessage: "503 server error first" }),
      fauxAssistantMessage(fauxText("last"), { stopReason: "error", errorMessage: "503 server error final" }),
    ]);
    (session.settingsManager as never as { getRetrySettings: () => unknown }).getRetrySettings = () => ({ enabled: true, maxRetries: 1, baseDelayMs: 0, maxAgentDelayMs: 0 });
    try {
      await session.prompt("/goal retry-work", { source: "rpc" } as never);
      await session.waitForIdle();
      expect(statuses.at(-1)?.snapshot).toMatchObject({ status: "paused", pauseReason: { code: "request-error" }, runRoundsStarted: 1 });
      const entries = session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "goal");
      expect(entries.map((entry) => (entry as { data: { kind: string } }).data.kind)).toEqual(["create", "round", "pause"]);
    } finally { session.dispose(); }
  }, 30_000);

  it("holds one Goal round across real visual review redo and explicit approval", async () => {
    const previews: string[] = [];
    const requests: Array<{ data: { visualReview: { previewId: string }; questions: Array<{ options: Array<{ id: string }>; allowCustom: boolean }> }; answer: (value: string) => void }> = [];
    const uiInput = (payload: string) => new Promise<string>((resolve) => {
      requests.push({ data: JSON.parse(payload).data, answer: resolve });
    });
    const session = await sessionWith([
      fauxAssistantMessage(fauxToolCall("show_visual", { html: "<p>version 1</p>", mode: "panel" })),
      () => fauxAssistantMessage(fauxToolCall("ask_user", { visualReview: { previewId: previews.at(-1)! }, questions: [{ question: "Choose", options: [{ label: "A" }] }] })),
      fauxAssistantMessage(fauxToolCall("show_visual", { html: "<p>version 2</p>", mode: "panel" })),
      () => fauxAssistantMessage(fauxToolCall("ask_user", { visualReview: { previewId: previews.at(-1)! }, questions: [{ question: "Choose", options: [{ label: "B" }] }] })),
      () => { const goal = statuses.at(-1)!.snapshot; return fauxAssistantMessage(fauxToolCall("update_goal", { goalId: goal.goalId, revision: goal.revision, action: "complete" })); },
      fauxAssistantMessage(fauxText("finished")),
    ], [], { visualReview: true, input: uiInput, visualStatus: (value) => previews.push(value.previewId) });
    try {
      await session.prompt("/goal review this design", { source: "rpc" } as never);
      await vi.waitUntil(() => requests.length === 1, { timeout: 6000 });
      expect(statuses.at(-1)?.snapshot).toMatchObject({ status: "active", runRoundsStarted: 1 });
      expect(requests[0].data.visualReview.previewId).toBe(previews[0]);
      expect(requests[0].data.questions[0]).toMatchObject({ allowCustom: false, options: [{ id: "approve" }, { id: "redo" }] });
      requests[0].answer(JSON.stringify({ __askUserAnswer: 1, text: "redo version 1", review: { previewId: previews[0], outcome: "redo" } }));
      await vi.waitUntil(() => requests.length === 2, { timeout: 6000 });
      expect(previews[1]).not.toBe(previews[0]);
      const first = session.messages.filter((message) => message.role === "toolResult").find((message) => message.toolName === "ask_user");
      expect(first?.details).toMatchObject({ review: { previewId: previews[0], outcome: "redo" } });
      expect(statuses.at(-1)?.snapshot).toMatchObject({ status: "active", runRoundsStarted: 1 });
      requests[1].answer(JSON.stringify({ __askUserAnswer: 1, text: "approved version 2", review: { previewId: previews[1], outcome: "approved" } }));
      await session.waitForIdle();
      const reviews = session.messages.filter((message) => message.role === "toolResult").filter((message) => message.toolName === "ask_user")
        .map((message) => message.details);
      expect(reviews).toMatchObject([{ review: { outcome: "redo", previewId: previews[0] } }, { review: { outcome: "approved", previewId: previews[1] } }]);
      expect(statuses.at(-1)?.snapshot).toMatchObject({ status: "complete", runRoundsStarted: 1 });
      logGoalSequence("review-redo-approval", session, [{ previews, reviews }]);
    } finally {
      for (const request of requests) request.answer(JSON.stringify({ __askUserAnswer: 1, text: "cancelled" }));
      session.dispose();
    }
  }, 30_000);

  it("final automatic compaction failure wins after a visual review redo", async () => {
    const previews: string[] = [];
    let answer: (value: string) => void = () => {};
    let requested = false;
    let summaryRequests = 0;
    const sdkEvents: Array<{ type: string; reason?: string; errorMessage?: string }> = [];
    const responder = (context: unknown) => {
      if (JSON.stringify(context).includes("<conversation>")) {
        summaryRequests++;
        return fauxAssistantMessage(fauxText("incomplete"), { stopReason: "length" });
      }
      return fauxAssistantMessage(fauxText("working"));
    };
    const session = await sessionWith([
      fauxAssistantMessage(fauxText("warmup")),
      fauxAssistantMessage(fauxToolCall("show_visual", { html: "<p>redo me</p>", mode: "panel" })),
      () => fauxAssistantMessage(fauxToolCall("ask_user", { visualReview: { previewId: previews[0] }, questions: [{ question: "Review", options: [{ label: "A" }] }] })),
      ...Array.from({ length: 6 }, () => responder),
    ] as never, [], { visualReview: true, visualStatus: (value) => previews.push(value.previewId),
      input: () => new Promise<string>((resolve) => { requested = true; answer = resolve; }) });
    const sessionId = session.sessionManager.getSessionId();
    const unsubscribe = session.subscribe((event) => {
      if (event.type !== "compaction_start" && event.type !== "compaction_end") return;
      sdkEvents.push({ type: event.type, reason: event.reason,
        ...(event.type === "compaction_end" ? { errorMessage: event.errorMessage } : {}) });
      observeCompactionEvent({ sessionId }, event);
    });
    try {
      await session.prompt("Warm up before review", { source: "rpc" } as never);
      await session.waitForIdle();
      await session.prompt("/goal review and revise", { source: "rpc" } as never);
      await vi.waitUntil(() => requested, { timeout: 6000 });
      expect(statuses.at(-1)?.snapshot).toMatchObject({ status: "active", runRoundsStarted: 1 });
      session.settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: 128000, keepRecentTokens: 0 } });
      answer(JSON.stringify({ __askUserAnswer: 1, text: "redo before completion", review: { previewId: previews[0], outcome: "redo" } }));
      await session.waitForIdle();
      expect(summaryRequests).toBeGreaterThan(0);
      expect(sdkEvents).toContainEqual(expect.objectContaining({ type: "compaction_end", reason: "threshold", errorMessage: expect.stringContaining("incomplete") }));
      expect(statuses.at(-1)?.snapshot).toMatchObject({ status: "paused", pauseReason: { code: "request-error" }, runRoundsStarted: 1 });
      const goalEvents = session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "goal");
      expect(goalEvents.map((entry) => (entry as { data: { kind: string } }).data.kind)).toEqual(["create", "round", "pause"]);
      logGoalSequence("review-redo-compaction-failure", session, [{ previews, sdkEvents }]);
    } finally { answer(JSON.stringify({ __askUserAnswer: 1, text: "cancelled" })); unsubscribe(); session.dispose(); }
  }, 30_000);

  it("keeps an explicit human pause ahead of a late visual review approval", async () => {
    const previews: string[] = [];
    let answer: (value: string) => void = () => {};
    let requested = false;
    const session = await sessionWith([
      fauxAssistantMessage(fauxToolCall("show_visual", { html: "<p>pending</p>", mode: "panel" })),
      () => fauxAssistantMessage(fauxToolCall("ask_user", { visualReview: { previewId: previews[0] }, questions: [{ question: "Review", options: [{ label: "A" }] }] })),
      () => { const goal = statuses.at(-1)!.snapshot; return fauxAssistantMessage(fauxToolCall("update_goal", { goalId: goal.goalId, revision: goal.revision, action: "complete" })); },
      fauxAssistantMessage(fauxText("finished")),
    ], [], { visualReview: true, visualStatus: (value) => previews.push(value.previewId),
      input: () => new Promise<string>((resolve) => { requested = true; answer = resolve; }) });
    try {
      await session.prompt("/goal review and wait", { source: "rpc" } as never);
      await vi.waitUntil(() => requested, { timeout: 6000 });
      await session.prompt("/goal pause", { source: "rpc" } as never);
      expect(statuses.at(-1)?.snapshot).toMatchObject({ status: "paused", pauseReason: { code: "user" }, runRoundsStarted: 1 });
      answer(JSON.stringify({ __askUserAnswer: 1, text: "approved too late", review: { previewId: previews[0], outcome: "approved" } }));
      await session.waitForIdle();
      const goalEvents = session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "goal");
      expect(goalEvents.map((entry) => (entry as { data: { kind: string } }).data.kind)).toEqual(["create", "round", "pause"]);
      expect(statuses.at(-1)?.snapshot).toMatchObject({ status: "paused", pauseReason: { code: "user" }, runRoundsStarted: 1 });
      const attempted = session.messages.find((message) => message.role === "toolResult" && message.toolName === "update_goal");
      expect(JSON.stringify(attempted)).toContain("GOAL_TOOL_ROUND_STALE");
      logGoalSequence("review-user-pause-late-approval", session, [{ previewId: previews[0], lateUpdate: attempted }]);
    } finally { answer(JSON.stringify({ __askUserAnswer: 1, text: "cancelled" })); session.dispose(); }
  }, 30_000);

  it("interleaves a pending visual review with real SDK compaction, redo, approval and one continuation", async () => {
    let releaseSummary: () => void = () => {};
    let summaryPending = false;
    const previews: string[] = [];
    const requests: Array<{ previewId: string; answer: (value?: string) => void }> = [];
    const sdkEvents: Array<{ type: string; reason?: string; errorMessage?: string }> = [];
    const uiInput = (payload: string, _placeholder: unknown, options: { signal?: AbortSignal }) => new Promise<string | undefined>((resolve) => {
      const previewId = JSON.parse(payload).data.visualReview.previewId as string;
      requests.push({ previewId, answer: resolve });
      options.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
    });
    const ask = () => fauxAssistantMessage(fauxToolCall("ask_user", {
      visualReview: { previewId: previews.at(-1)! }, questions: [{ question: "Review this version", options: [{ label: "Alternative" }] }],
    }));
    const session = await sessionWith([
      fauxAssistantMessage(fauxText("warmup")),
      fauxAssistantMessage(fauxToolCall("show_visual", { html: "<p>old</p>", mode: "panel" })), ask,
      async () => { summaryPending = true; await new Promise<void>((resolve) => { releaseSummary = resolve; }); return fauxAssistantMessage(fauxText("compaction checkpoint")); },
      fauxAssistantMessage(fauxText("turn prefix checkpoint")),
      fauxAssistantMessage(fauxToolCall("show_visual", { html: "<p>revision 2</p>", mode: "panel" })), ask,
      fauxAssistantMessage(fauxToolCall("show_visual", { html: "<p>revision 3</p>", mode: "panel" })), ask,
      () => { const goal = statuses.at(-1)!.snapshot; return fauxAssistantMessage(fauxToolCall("update_goal", { goalId: goal.goalId, revision: goal.revision, action: "complete" })); },
      fauxAssistantMessage(fauxText("finished")),
    ], [], { visualReview: true, input: uiInput, visualStatus: (value) => previews.push(value.previewId) });
    const sessionId = session.sessionManager.getSessionId();
    const unsubscribe = session.subscribe((event) => {
      if (event.type !== "compaction_start" && event.type !== "compaction_end") return;
      sdkEvents.push({ type: event.type, reason: event.reason,
        ...(event.type === "compaction_end" ? { errorMessage: event.errorMessage } : {}) });
      observeCompactionEvent({ sessionId }, event);
    });
    try {
      await session.prompt("Build context before review", { source: "rpc" } as never);
      await session.waitForIdle();
      await session.prompt("/goal review each design", { source: "rpc" } as never);
      await vi.waitUntil(() => requests.length === 1, { timeout: 6000 });
      expect(statuses.at(-1)?.snapshot).toMatchObject({ status: "active", runRoundsStarted: 1 });
      session.settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 0 } });
      beginCompactionIntent({ sessionId }, "policy-auto");
      const compacting = session.compact();
      await vi.waitUntil(() => summaryPending, { timeout: 6000 });
      expect(statuses.at(-1)?.snapshot).toMatchObject({ status: "active", runRoundsStarted: 1 });
      expect(requests[0].previewId).toBe(previews[0]);
      releaseSummary();
      await compacting;
      await vi.waitUntil(() => requests.length === 2, { timeout: 6000 });
      expect(statuses.at(-1)?.snapshot).toMatchObject({ status: "active", runRoundsStarted: 2 });
      expect(previews[1]).not.toBe(previews[0]);
      // The aborted first tool may be omitted from the SDK's compacted projection;
      // its old preview must never be reused or silently counted as approved.
      requests[1].answer(JSON.stringify({ __askUserAnswer: 1, text: "redo", review: { previewId: previews[1], outcome: "redo" } }));
      await vi.waitUntil(() => requests.length === 3, { timeout: 6000 });
      requests[2].answer(JSON.stringify({ __askUserAnswer: 1, text: "approve", review: { previewId: previews[2], outcome: "approved" } }));
      await session.waitForIdle();
      const reviews = session.messages.filter((message) => message.role === "toolResult").filter((message) => message.toolName === "ask_user")
        .map((message) => message.details);
      expect(reviews.filter((review) => (review as { review?: { outcome: string } })?.review?.outcome === "approved")).toHaveLength(1);
      expect(reviews).toMatchObject([{ review: { outcome: "redo", previewId: previews[1] } }, { review: { outcome: "approved", previewId: previews[2] } }]);
      expect(sdkEvents).toEqual([expect.objectContaining({ type: "compaction_start", reason: "manual" }),
        expect.objectContaining({ type: "compaction_end", reason: "manual", errorMessage: undefined })]);
      expect(statuses.at(-1)?.snapshot).toMatchObject({ status: "complete", runRoundsStarted: 2 });
      logGoalSequence("review-compaction-redo-approval", session, [{ previews, reviews, sdkEvents }]);
    } finally {
      releaseSummary();
      for (const request of requests) request.answer(undefined);
      unsubscribe(); session.dispose();
    }
  }, 30_000);

  it("keeps Goal serial while the real SDK summary is pending and resumes after commit", async () => {
    let releaseSummary: () => void = () => {};
    let summaryPending = false;
    let gateReached = false;
    let releaseGate: () => void = () => {};
    const gate = (pi: { registerTool: (tool: unknown) => void }) => pi.registerTool({
      name: "compaction_round_gate", label: "Gate", description: "Hold the resumed round.", promptSnippet: "Hold resumed work.",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => {
        gateReached = true;
        await new Promise<void>((resolve) => { releaseGate = resolve; });
        return { content: [{ type: "text", text: "released" }], details: {} };
      },
    });
    const session = await sessionWith([
      fauxAssistantMessage(fauxText("warmup")),
      async () => { summaryPending = true; await new Promise<void>((resolve) => { releaseSummary = resolve; }); return fauxAssistantMessage(fauxText("confirmed checkpoint")); },
      fauxAssistantMessage(fauxText("first round done")),
      fauxAssistantMessage(fauxToolCall("compaction_round_gate", {})),
      fauxAssistantMessage(fauxText("done")),
    ], [gate]);
    const sessionId = session.sessionManager.getSessionId();
    const compactEvents: Array<{ type: string; reason?: string; errorMessage?: string }> = [];
    const unsubscribe = session.subscribe((event) => {
      if (event.type !== "compaction_start" && event.type !== "compaction_end") return;
      compactEvents.push({ type: event.type, reason: event.reason,
        ...(event.type === "compaction_end" ? { errorMessage: event.errorMessage } : {}) });
      observeCompactionEvent({ sessionId }, event);
      if (event.type === "compaction_end" && !event.errorMessage) session.settingsManager.applyOverrides({ compaction: { enabled: false } });
    });
    try {
      await session.prompt("Warm up history", { source: "rpc" } as never);
      await session.waitForIdle();
      session.settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: 128000, keepRecentTokens: 0 } });
      await session.prompt("/goal summarizing", { source: "rpc" } as never);
      await vi.waitUntil(() => summaryPending, { timeout: 6000 });
      expect(statuses.at(-1)?.snapshot).toMatchObject({ status: "active", runRoundsStarted: 1 });
      expect(session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "goal"
        && (entry.data as { kind?: string }).kind === "round")).toHaveLength(1);
      releaseSummary();
      await vi.waitUntil(() => gateReached, { timeout: 6000 });
      logGoalSequence("compaction-success", session, compactEvents);
      expect(compactEvents).toEqual([
        expect.objectContaining({ type: "compaction_start", reason: "threshold" }),
        expect.objectContaining({ type: "compaction_end", reason: "threshold", errorMessage: undefined }),
      ]);
      expect(statuses.at(-1)?.snapshot).toMatchObject({ status: "active", runRoundsStarted: 2 });
      await session.prompt("/goal pause", { source: "rpc" } as never);
      releaseGate();
      await session.waitForIdle();
      expect(statuses.at(-1)?.snapshot).toMatchObject({ status: "paused", pauseReason: { code: "user" } });
    } finally { releaseSummary(); releaseGate(); unsubscribe(); session.dispose(); }
  }, 30_000);

  it("pauses only after a real SDK automatic compaction has finally failed", async () => {
    let summaryRequests = 0;
    let workRequests = 0;
    const respond = (context: unknown) => {
      if (JSON.stringify(context).includes("<conversation>")) {
        summaryRequests++;
        return fauxAssistantMessage(fauxText("incomplete summary"), { stopReason: "length" });
      }
      return fauxAssistantMessage(fauxText(`working response ${++workRequests}`));
    };
    const session = await sessionWith(Array.from({ length: 8 }, () => respond) as never);
    const compactEvents: Array<{ type: string; reason?: string; errorMessage?: string }> = [];
    const sessionId = session.sessionManager.getSessionId();
    const unsubscribe = session.subscribe((event) => {
      if (event.type !== "compaction_start" && event.type !== "compaction_end") return;
      compactEvents.push({ type: event.type, reason: event.reason,
        ...(event.type === "compaction_end" ? { errorMessage: event.errorMessage } : {}) });
      observeCompactionEvent({ sessionId }, event);
    });
    try {
      await session.prompt("Warm up history", { source: "rpc" } as never);
      await session.waitForIdle();
      session.settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: 128000, keepRecentTokens: 0 } });
      await session.prompt("/goal summarize-and-work", { source: "rpc" } as never);
      await session.waitForIdle();
      logGoalSequence("compaction-failure", session, compactEvents);
      expect(summaryRequests).toBeGreaterThan(0);
      expect(compactEvents).toContainEqual(expect.objectContaining({ type: "compaction_start", reason: "threshold" }));
      expect(compactEvents.filter((event) => event.type === "compaction_end" && event.errorMessage)).toEqual([
        expect.objectContaining({ reason: "threshold", errorMessage: expect.stringContaining("incomplete") }),
      ]);
      const entries = session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "goal");
      expect(entries.map((entry) => (entry as { data: { kind: string } }).data.kind)).toEqual(["create", "round", "pause"]);
      expect(statuses.at(-1)?.snapshot).toMatchObject({ status: "paused", pauseReason: { code: "request-error" }, runRoundsStarted: 1 });
    } finally { unsubscribe(); session.dispose(); }
  }, 30_000);

  it("records an explicit user pause for a cancelled SDK round", async () => {
    let reached = false;
    const gate = (pi: { registerTool: (tool: unknown) => void }) => pi.registerTool({
      name: "abort_gate", label: "Gate", description: "Wait until aborted.", promptSnippet: "Wait for cancellation.",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async (_id: unknown, _params: unknown, signal: AbortSignal) => {
        reached = true;
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { content: [{ type: "text", text: "aborted" }], details: {} };
      },
    });
    const session = await sessionWith([
      fauxAssistantMessage(fauxToolCall("abort_gate", {})),
      () => {
        const goal = statuses.at(-1)!.snapshot;
        return fauxAssistantMessage(fauxToolCall("update_goal", { goalId: goal.goalId, revision: goal.revision, action: "complete" }));
      },
      fauxAssistantMessage(fauxText("recovered")),
    ], [gate]);
    try {
      await session.prompt("/goal cancel-test", { source: "rpc" } as never);
      await vi.waitUntil(() => reached, { timeout: 6000 });
      await session.abort();
      await session.waitForIdle();
      const paused = statuses.at(-1)?.snapshot;
      expect(paused).toMatchObject({ status: "paused", pauseReason: { code: "user" }, runNumber: 1, runRoundsStarted: 1 });
      await session.prompt("/goal resume", { source: "rpc" } as never);
      await session.waitForIdle();
      expect(statuses.at(-1)?.snapshot).toMatchObject({ goalId: paused.goalId, status: "complete", runNumber: 1, runRoundsStarted: 2 });
      logGoalSequence("user-stop-and-resume", session);
      const kinds = session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "goal")
        .map((entry) => (entry as { data: { kind: string } }).data.kind);
      expect(kinds).toEqual(["create", "round", "pause", "resume", "round", "complete"]);
    } finally { session.dispose(); }
  }, 30_000);

  it("replays failure, canonical pull, human resume, edit, cap, and trusted new batch on the real SDK", async () => {
    let gateReached = false;
    let releaseGate: () => void = () => {};
    const gate = (pi: { registerTool: (tool: unknown) => void }) => pi.registerTool({
      name: "chain_gate", label: "Gate", description: "Hold edit-boundary work.", promptSnippet: "Hold work.",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => {
        gateReached = true;
        await new Promise<void>((resolve) => { releaseGate = resolve; });
        return { content: [{ type: "text", text: "released" }], details: {} };
      },
    });
    const session = await sessionWith([
      fauxAssistantMessage(fauxText("failed"), { stopReason: "error", errorMessage: "permanent fixture request failure" }),
      fauxAssistantMessage(fauxToolCall("chain_gate", {})),
      fauxAssistantMessage(fauxText("old condition settled")),
      fauxAssistantMessage(fauxText("updated condition settled")),
      () => {
        const goal = statuses.at(-1)!.snapshot;
        return fauxAssistantMessage(fauxToolCall("update_goal", { goalId: goal.goalId, revision: goal.revision, action: "complete" }));
      },
      fauxAssistantMessage(fauxText("complete")),
    ], [gate]);
    const sessionId = session.sessionManager.getSessionId();
    session.settingsManager.applyOverrides({ retry: { enabled: false } });
    try {
      const created = await controlGoal(sessionId, {
        operationId: "chain-create", action: "create", goalId: "", expectedRevision: 0,
        expectedConditionRevision: 0, condition: "original", maxRounds: 3,
      });
      expect(created).toMatchObject({ outcome: "committed", snapshot: { runNumber: 1, maxRounds: 3 } });
      await vi.waitUntil(() => statuses.at(-1)?.snapshot?.pauseReason?.code === "request-error", { timeout: 6000 });
      const diskPull = buildGoalStatus({ entries: session.sessionManager.getEntries(), sessionId });
      expect(diskPull.snapshot).toMatchObject({ status: "paused", runRoundsStarted: 1, pauseReason: { code: "request-error" } });
      await session.prompt("/goal resume", { source: "rpc" } as never);
      await vi.waitUntil(() => gateReached, { timeout: 6000 });
      expect(statuses.at(-1)?.snapshot).toMatchObject({ status: "active", runRoundsStarted: 2 });
      await session.prompt("/goal edit updated", { source: "rpc" } as never);
      expect(statuses.at(-1)?.snapshot).toMatchObject({ status: "active", condition: "updated", conditionRevision: 2 });
      releaseGate();
      await vi.waitUntil(() => statuses.at(-1)?.snapshot?.pauseReason?.code === "max-rounds", { timeout: 6000 });
      expect(statuses.at(-1)?.snapshot).toMatchObject({ status: "paused", runNumber: 1, runRoundsStarted: 3, maxRounds: 3 });
      await session.prompt("/goal resume", { source: "rpc" } as never);
      await session.waitForIdle();
      expect(statuses.at(-1)?.snapshot).toMatchObject({ status: "complete", runNumber: 2, runRoundsStarted: 1, roundsStarted: 4, conditionRevision: 2 });
      const kinds = session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "goal")
        .map((entry) => (entry as { data: { kind: string } }).data.kind);
      logGoalSequence("failure-pull-resume-edit-cap-restart-complete", session, [{ type: "canonical-pull", snapshot: diskPull.snapshot }]);
      expect(kinds).toEqual(["create", "round", "pause", "resume", "round", "edit", "round", "pause", "restart", "round", "complete"]);
    } finally { releaseGate(); session.dispose(); }
  }, 30_000);

  it("a codemode nested update retains its parent call's revoked round after edit", async () => {
    let release: () => void = () => {};
    let reached = 0;
    const gate = (pi: { registerTool: (tool: unknown) => void }) => pi.registerTool({
      name: "auth_gate", label: "Gate", description: "Pause nested execution for lifecycle fixture.", promptSnippet: "Pause execution.",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => {
        await new Promise<void>((resolve) => { release = resolve; reached++; });
        return { content: [{ type: "text", text: "released" }], details: {} };
      },
    });
    statuses.length = 0;
    faux.setResponses([
      () => {
        const goal = statuses.at(-1)!.snapshot;
        return fauxAssistantMessage(fauxToolCall("codemode", {
          code: `await tools.auth_gate({}); const r = await tools.update_goal({ goalId: ${JSON.stringify(goal.goalId)}, revision: ${goal.revision + 1}, action: "complete" }); return JSON.stringify(r);`,
        }));
      },
      fauxAssistantMessage(fauxText("old work finished")),
      fauxAssistantMessage(fauxToolCall("auth_gate", {})),
      fauxAssistantMessage(fauxText("new work continues")),
    ]);
    const services = await createAgentSessionServices({
      cwd: ws, agentDir: home, modelRuntime: runtime,
      resourceLoaderOptions: { additionalExtensionPaths: [join(overlay, "goal", "index.ts")], extensionFactories: [gate as never, createCodemodeExtension()], noExtensions: true, noContextFiles: true },
    });
    const model = resolveCliModel({ cliModel: "faux/faux-1", modelRuntime: services.modelRuntime }).model;
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(ws), model });
    await session.bindExtensions({ uiContext: { notify: () => {}, setStatus: (key: string, text?: string) => {
      if (key === "goal" && text) statuses.push(JSON.parse(text));
    } } as never });
    session.setActiveToolsByName([...new Set([...session.getActiveToolNames(), "codemode", "update_goal", "auth_gate"])]);
    try {
      await session.prompt("/goal initial", { source: "rpc" } as never);
      await vi.waitUntil(() => reached === 1, { timeout: 6000 });
      await session.prompt("/goal edit updated", { source: "rpc" } as never);
      release();
      await vi.waitUntil(() => reached === 2, { timeout: 6000 });
      await session.prompt("/goal pause", { source: "rpc" } as never);
      release();
      await session.waitForIdle();
      const result = session.messages.find((message) => message.role === "toolResult" && message.toolName === "codemode") as { content?: Array<{text?:string}> } | undefined;
      expect(JSON.stringify(result?.content)).toContain("GOAL_TOOL_ROUND_STALE");
      expect(statuses.at(-1)?.snapshot).toMatchObject({ condition: "updated", status: "paused", conditionRevision: 2, pauseReason: { code: "user" } });
      expect(session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "goal" && (entry.data as { kind?: string }).kind === "complete")).toHaveLength(0);
    } finally { release(); session.dispose(); }
  }, 30_000);
});
