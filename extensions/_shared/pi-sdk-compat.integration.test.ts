import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import {
  AgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { makeGrenRuntimeFactory } from "../../cli/src/gren-runtime.js";
import { SessionUiAdapter, type UiEnvelope } from "../../electron-agent/electron/agent/sessionUiAdapter.js";
import { toRendererEvent } from "../../electron-agent/electron/agent/streamingEvent.js";
import { adaptPiEvent } from "../../electron-agent/electron/pi/eventAdapter.js";
import headerPlaceholders from "../header-placeholders/index.js";
import { sessionCwdController } from "./session-cwd.js";
import { batchToolRefresh } from "./tool-refresh-batch.js";

// Characterize the private SDK assumptions used by Gren. A renamed registry hook,
// a runner that captures cwd, lost request headers/preflight callbacks, or a broken
// compaction projection must fail through an actual session, not a fake session.
type Request = { headers: IncomingHttpHeaders; body: Record<string, unknown> };
const cleanups: Array<() => Promise<unknown> | unknown> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(extraFactories: ExtensionFactory[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "gren-sdk-compat-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const cwd = join(dir, "project");
  const agentDir = join(dir, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  const requests: Request[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push({ headers: request.headers, body });
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    const base = { id: "compat-fixture", object: "chat.completion.chunk", created: 1, model: "fixture" };
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Fixture response" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server has no port");
  const modelsPath = join(agentDir, "models.json");
  await writeFile(modelsPath, JSON.stringify({ providers: { "compat-fixture": {
    api: "openai-completions",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "local-fixture-key",
    headers: { "x-gren-session": "{sessionId}", "x-gren-static": "preserved" },
    models: [{ id: "fixture", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096 }],
  } } }));
  const modelRuntime = await ModelRuntime.create({
    modelsPath, authPath: join(agentDir, "auth.json"),
    modelsStorePath: join(agentDir, "model-cache.json"), allowModelNetwork: false,
  });
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: "compat-fixture", defaultModel: "fixture", cacheWarming: "off",
    compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 64 },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  });
  const sessionManager = SessionManager.create(cwd, join(dir, "sessions"));
  const factory = makeGrenRuntimeFactory({
    modelRuntime, extraFactories: [headerPlaceholders, ...extraFactories],
    deps: {
      manifestExtensions: [],
      getConfig: (key) => key === "PI_DISABLE_PROJECT_CONTEXT" ? "1" : undefined,
      createAgentSessionServices: (options) => createAgentSessionServices({
        ...options, settingsManager,
        resourceLoaderOptions: {
          ...options.resourceLoaderOptions, noExtensions: true,
          noSkills: true, noPromptTemplates: true, noThemes: true,
        },
      }),
      createAgentSessionFromServices: (options) => createAgentSessionFromServices({
        ...options, noTools: "builtin", model: modelRuntime.getModel("compat-fixture", "fixture"),
      }),
    },
  });
  const created = await factory({ cwd, agentDir, sessionManager });
  cleanups.push(() => created.session.dispose());
  return { ...created, cwd, dir, requests, sessionManager };
}

describe("Gren compatibility with the installed Pi SDK", () => {
  it("batches real dynamic tool registration and exposes every registered tool", async () => {
    const prototype = AgentSession.prototype as unknown as { _refreshToolRegistry(options?: unknown): unknown };
    const refresh = vi.spyOn(prototype, "_refreshToolRegistry");
    let api: ExtensionAPI | undefined;
    const { session } = await fixture([(pi) => { api = pi; }]);
    await session.bindExtensions({ mode: "rpc" });
    refresh.mockClear();
    batchToolRefresh(() => {
      for (const name of ["compat_one", "compat_two", "compat_three"]) api!.registerTool({
        name, label: name, description: "Return a local fixture result.",
        promptSnippet: "Return a local fixture result.", parameters: Type.Object({}),
        async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; },
      });
      expect(session.getAllTools().some((tool) => tool.name === "compat_one")).toBe(false);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(session.getAllTools().map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "compat_one", "compat_two", "compat_three",
    ]));
  });

  it("uses the moved cwd, reports accepted preflight, and expands session headers on a real request", async () => {
    const seenCwd: string[] = [];
    const { cwd, session, requests, sessionManager } = await fixture([(pi) => {
      pi.on("before_agent_start", (_event, ctx) => {
        seenCwd.push(ctx.cwd);
        ctx.ui.notify("SDK fixture notice", "info");
      });
    }]);
    const notices: UiEnvelope[] = [];
    const adapter = new SessionUiAdapter({
      workspace: cwd, sessionId: () => session.sessionId,
      isGoalTurn: () => false, emit: (envelope) => notices.push(envelope),
    });
    await session.bindExtensions({ mode: "rpc", uiContext: adapter.context });
    const rendererEvents: Record<string, unknown>[] = [];
    const projectionTypes: string[] = [];
    cleanups.push(session.subscribe((event) => {
      rendererEvents.push(toRendererEvent(event));
      const projected = adaptPiEvent(event as unknown as Record<string, unknown>);
      if (projected) projectionTypes.push(projected.type);
    }));
    const moved = join(cwd, "nested");
    await mkdir(moved);
    sessionCwdController(session.sessionId)!.set(moved);
    const dispositions: string[] = [];
    await session.prompt("Reply using the local fixture.", { preflightResult: (value) => dispositions.push(value) });
    await session.waitForIdle();
    expect(dispositions).toEqual(["started"]);
    expect(seenCwd).toEqual([moved]);
    expect((session as unknown as { _cwd: string })._cwd).toBe(moved);
    expect(sessionManager.getCwd()).toBe(cwd);
    expect(requests).toHaveLength(1);
    expect(requests[0].headers["x-gren-session"]).toBe(session.sessionId);
    expect(requests[0].headers["x-gren-static"]).toBe("preserved");
    expect(requests[0].body.model).toBe("fixture");
    expect(session.messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "Fixture response" }] });
    expect(notices).toContainEqual(expect.objectContaining({
      sessionId: session.sessionId,
      request: expect.objectContaining({ method: "notify", message: "SDK fixture notice" }),
    }));
    expect(projectionTypes).toContain("turn.started");
    expect(projectionTypes).toContain("item.delta");
    expect(projectionTypes.at(-1)).toBe("turn.completed");
    const update = rendererEvents.find((event) =>
      event.type === "message_update" && (event.assistantMessageEvent as { type?: string })?.type === "text_delta");
    expect(update).toMatchObject({ assistantMessageEvent: { type: "text_delta", delta: "Fixture response" } });
    expect(update).not.toHaveProperty("message");
  });

  it("compacts with the model output limit and persists a replayable projection", async () => {
    const compactEvents: Array<{ fromExtension: boolean }> = [];
    const { session, sessionManager, requests } = await fixture([(pi) => {
      pi.on("session_compact", (event) => { compactEvents.push(event); });
    }]);
    await session.bindExtensions({ mode: "rpc" });
    for (let index = 0; index < 4; index++) {
      await session.prompt(`Fixture turn ${index}: ${"history ".repeat(120)}`);
      await session.waitForIdle();
      const last = session.messages.at(-1) as { errorMessage?: string };
      expect(last.errorMessage).toBeUndefined();
    }
    const before = requests.length;
    const result = await session.compact();
    const summaries = requests.slice(before);
    expect(summaries.length).toBeGreaterThan(0);
    for (const { body } of summaries) {
      const maxTokens = body.max_tokens ?? body.max_completion_tokens;
      expect(typeof maxTokens).toBe("number");
      expect(maxTokens).toBeGreaterThan(0);
      // Pi 1.4 keeps reserveTokens for input headroom; summary output uses the model limit.
      expect(maxTokens).toBe(4096);
    }
    expect(result.summary).toContain("Fixture response");
    expect(compactEvents).toEqual([expect.objectContaining({ fromExtension: false })]);
    expect(session.messages.some((message) => message.role === "compactionSummary")).toBe(true);
    const path = sessionManager.getSessionFile()!;
    const persisted = (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    expect(persisted.some((entry) => entry.type === "compaction" && entry.summary.includes("Fixture response"))).toBe(true);
    const reopened = SessionManager.open(path);
    expect(reopened.buildSessionProjection().messages.some((message) => message.role === "compactionSummary")).toBe(true);
    await session.prompt("Continue after compaction.");
    await session.waitForIdle();
    expect(session.getLastAssistantText()).toBe("Fixture response");
    expect(requests.length).toBe(before + summaries.length + 1);
    expect(requests.at(-1)!.headers["x-gren-session"]).toBe(session.sessionId);
  });
});
