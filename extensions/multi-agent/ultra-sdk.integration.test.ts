import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { runInWorkspace } from "../_shared/workspace-context.js";
import { setSharedModelRuntime } from "../_shared/shared-model-runtime.js";
import { __resetForTest as resetRuntimeConfig } from "../_shared/runtime-config.js";
import { runEmbeddedSubagent } from "./embedded-runner.js";
import { openResumedChildSession } from "./activation.js";
import { isUltraRouting } from "../_shared/ultra-context.js";
import { resolveUltraRoute } from "./routing.js";
import type { RouteModel } from "./model-selection.js";

let dir = "";
let server: Server | undefined;
afterEach(async () => {
  setSharedModelRuntime(undefined);
  resetRuntimeConfig();
  vi.unstubAllEnvs();
  if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server!.close(() => resolve())); server = undefined; }
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("Ultra real SDK sessions", () => {
  it("sends two provider/model routes and per-node effort through real child sessions, and restores their records", async () => {
    dir = await mkdtemp(join(tmpdir(), "gren-ultra-sdk-"));
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({ url: request.url ?? "", body });
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
      const base = { id: "fixture-chat", object: "chat.completion.chunk", created: 1, model: body.model };
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: `DONE ${body.model}` }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server has no port");
    const providers = Object.fromEntries(["fixture-one", "fixture-two"].map((provider, i) => [provider, {
      api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/${provider}/v1`, apiKey: "local-fixture-key",
      models: [{ id: `model-${i}`, reasoning: true, input: ["text"], contextWindow: i ? 32000 : 128000, maxTokens: 4096,
        thinkingLevelMap: { low: "low", high: "high" }, compat: { supportsReasoningEffort: true } }],
    }]));
    await writeFile(join(dir, "models.json"), JSON.stringify({ providers }));
    const config = { PI_SYSTEM_WORKER: "1", PI_SUBAGENT_ROUTING_MODE: "ultra", SUBAGENT_MODE: "disabled",
      ULTRA_SUBAGENT_MODEL_SCOUT: "fixture-one/model-0", ULTRA_SUBAGENT_MODEL_WORKER: "fixture-two/model-1" };
    const runtimePath = join(dir, "runtime-settings.json");
    await writeFile(runtimePath, JSON.stringify(config));
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    vi.stubEnv("PI_SYSTEM_WORKER", "1");
    vi.stubEnv("PI_RUNTIME_CONFIG", runtimePath);
    const runtime = await ModelRuntime.create({ modelsPath: join(dir, "models.json"), authPath: join(dir, "auth.json"), allowModelNetwork: false });
    expect(runtime.getError()).toBeUndefined();
    setSharedModelRuntime(runtime);
    const available = runtime.getAvailableSnapshot() as unknown as RouteModel[];
    const read = (key: string) => config[key as keyof typeof config];
    const results: string[] = [];
    for (const [index, agent, level] of [[0, "scout", "low"], [1, "worker", "high"]] as const) {
      const chosen = resolveUltraRoute({ agent, location: `tasks[${index}]`, available, read });
      const result = await runInWorkspace({ origin: "main", workspace: dir, cwd: dir, config }, () => runEmbeddedSubagent({
        cwd: dir, agentId: `ultra-sdk-${index}`, task: "Reply DONE using the fixture.", model: chosen.model, thinkingLevel: level,
        env: { PI_SUBAGENT_ROUTING_MODE: "ultra" },
      }));
      expect(result.ok, result.error).toBe(true);
      expect(result.output).toBe(`DONE model-${index}`);
      const entries = SessionManager.open(result.sessionPath).getEntries();
      expect(entries.some((entry) => entry.type === "model_change" && entry.provider === `fixture-${index ? "two" : "one"}` && entry.modelId === `model-${index}`)).toBe(true);
      const meta = entries.find((entry) => entry.type === "custom" && entry.customType === "subagent_meta");
      expect(meta && "data" in meta ? meta.data : undefined).toMatchObject({ routingMode: "ultra", model: chosen.model, thinkingLevel: level });
      expect((await readFile(result.sessionPath, "utf8")).length).toBeGreaterThan(0);
      results.push(result.sessionPath);
    }
    expect(results[0]).not.toBe(results[1]);
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toContain("/fixture-one/");
    expect(requests[1].url).toContain("/fixture-two/");
    expect(requests.map((request) => request.body.model)).toEqual(["model-0", "model-1"]);
    expect(requests.map((request) => request.body.reasoning_effort)).toEqual(["low", "high"]);
    expect(() => resolveUltraRoute({ agent: "worker", location: "tasks[1]", available, read: (key) => key === "ULTRA_SUBAGENT_MODEL_WORKER" ? "missing/model" : read(key) })).toThrow(/tasks\[1\].*ULTRA_SUBAGENT_MODEL_WORKER/);
    expect(requests).toHaveLength(2);
    // Reopen a real persisted child while its parent now uses ordinary settings.
    const ordinaryConfig = { ...config, PI_SUBAGENT_ROUTING_MODE: "ordinary", SUBAGENT_MODEL: "fixture-two/model-1" };
    const restored = await runInWorkspace({ origin: "main", workspace: dir, cwd: dir, config: ordinaryConfig }, () => openResumedChildSession(results[0]));
    try {
      expect(isUltraRouting({ cwd: dir, sessionManager: restored.sessionManager })).toBe(true);
      await restored.session.prompt("Reply DONE again.");
      await restored.session.waitForIdle();
      expect(requests).toHaveLength(3);
      expect(requests[2].url).toContain("/fixture-one/");
      expect(requests[2].body.model).toBe("model-0");
      expect(requests[2].body.reasoning_effort).toBe("low");
    } finally {
      restored.unsub();
      restored.session.dispose();
    }
    await writeFile(join(dir, "models.json"), JSON.stringify({ providers: { "fixture-two": providers["fixture-two"] } }));
    await runtime.refresh({ allowNetwork: false });
    const missingMessage = await openResumedChildSession(results[0]).then(
      (child) => { child.unsub(); child.session.dispose(); return ""; },
      (error: unknown) => String((error as Error).message),
    );
    // Assert a scalar diagnostic instead of dumping the whole SDK session on failure.
    expect(missingMessage).toContain("fixture-one/model-0");
    expect(requests).toHaveLength(3);
  }, 30000);
});
