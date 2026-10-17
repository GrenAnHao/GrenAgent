// 实跑（不联网）：真实 AgentSession + goal 扩展，模型换成 faux。
// 回合卡在一个工具里时发 `/goal <条件>`：扩展命令应当立刻执行、立刻 setStatus("goal")，
// 不等这一轮结束。

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pi-goal-live-agent-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
});

import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import goalExtension from "./index.js";

let release: () => void = () => {};
let gated = false;

function gateTool(pi: { registerTool: (tool: unknown) => void }): void {
  pi.registerTool({
    name: "gate",
    label: "Gate",
    description: "Test-only tool: blocks until the test releases it.",
    promptSnippet: "Test-only tool.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      await new Promise<void>((resolve) => { release = resolve; gated = true; });
      return { content: [{ type: "text", text: "GATE_DONE" }], details: {} };
    },
  });
}

describe("/goal while a turn is running (real SDK, faux model)", () => {
  const ws = mkdtempSync(join(tmpdir(), "pi-goal-live-ws-"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  let runtime: ModelRuntime;

  beforeAll(async () => {
    mkdirSync(join(home, "sessions"), { recursive: true });
    runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
  });

  afterAll(() => {
    rmSync(ws, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("pushes the goal status before the running turn ends", async () => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("gate", {})),
      fauxAssistantMessage(fauxText("turn done")),
      fauxAssistantMessage(fauxText("goal round reply")),
    ]);
    const services = await createAgentSessionServices({
      cwd: ws,
      agentDir: home,
      modelRuntime: runtime,
      resourceLoaderOptions: { extensionFactories: [gateTool as never, goalExtension as never], noContextFiles: true },
    });
    const model = resolveCliModel({ cliModel: "faux/faux-1", modelRuntime: services.modelRuntime }).model;
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(ws), model });
    const statuses: Array<{ key: string; text: string | undefined; streaming: boolean }> = [];
    const notes: string[] = [];
    await session.bindExtensions({
      uiContext: {
        notify: (message: string) => { notes.push(message); },
        setStatus: (key: string, text: string | undefined) => { statuses.push({ key, text, streaming: session.isStreaming }); },
      } as never,
    });
    try {
      const run = session.prompt("start working", { source: "rpc" } as never);
      await vi.waitUntil(() => gated, { timeout: 4000 });
      expect(session.isStreaming).toBe(true);
      const before = statuses.filter((s) => s.key === "goal").length;
      await session.prompt("/goal 写完测试", { source: "rpc" } as never);
      const goalStatuses = statuses.filter((s) => s.key === "goal");
      expect(goalStatuses.length).toBeGreaterThan(before);
      const last = goalStatuses.at(-1)!;
      expect(last.streaming).toBe(true);
      expect(JSON.parse(last.text ?? "null").snapshot).toMatchObject({ status: "active", condition: "写完测试" });
      release();
      await run;
      await session.waitForIdle();
    } finally {
      release();
      session.dispose();
    }
  });

  it("returns from an idle /goal as soon as the first round starts, with the round count already pushed", async () => {
    gated = false;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("gate", {})),
      fauxAssistantMessage(fauxText("round done")),
    ]);
    const services = await createAgentSessionServices({
      cwd: ws,
      agentDir: home,
      modelRuntime: runtime,
      resourceLoaderOptions: { extensionFactories: [gateTool as never, goalExtension as never], noContextFiles: true },
    });
    const model = resolveCliModel({ cliModel: "faux/faux-1", modelRuntime: services.modelRuntime }).model;
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(ws), model });
    const statuses: string[] = [];
    await session.bindExtensions({
      uiContext: {
        notify: () => {},
        setStatus: (key: string, text: string | undefined) => { if (key === "goal" && text) statuses.push(text); },
      } as never,
    });
    try {
      await session.prompt("/goal 跑一轮", { source: "rpc" } as never);
      // 命令已经返回，第一轮还卡在工具里。
      await vi.waitUntil(() => gated, { timeout: 4000 });
      expect(session.isStreaming).toBe(true);
      const last = JSON.parse(statuses.at(-1)!);
      expect(last.snapshot).toMatchObject({ status: "active", activation: "armed", roundsStarted: 1 });
      // 把续跑停掉，免得下一轮没有脚本可走。
      await session.prompt("/goal pause", { source: "rpc" } as never);
      release();
      await session.waitForIdle();
    } finally {
      release();
      session.dispose();
    }
  });
});
