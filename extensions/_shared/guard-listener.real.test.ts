// 实跑（不联网）：真实 AgentSession，模型换成 pi-ai 的 faux 供应商按脚本出一次工具调用。
// 工具在 execute 里调一次 onUpdate 再正常返回；会话上挂一个在 tool_execution_update 上抛错的监听方。
// 不包：SDK 等进度事件的 promise 时被拒（pi-agent-core agent-loop.js:587），execute 明明成功了，工具结果也丢了，
// 这一轮以一条 stopReason: error 的 assistant 消息结束，模型看不到工具结果。
// 用 guardListener 包上：工具结果是工具自己返回的那个。

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pi-guard-real-agent-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
});

import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { guardListener } from "./guard-listener.js";

type ToolResult = { role?: string; toolName?: string; isError?: boolean; content?: Array<{ type: string; text?: string }> };

const resultText = (r: ToolResult | undefined): string => (r?.content ?? []).map((c) => c.text ?? "").join("");

/** 调一次 onUpdate 再正常返回的工具。 */
function progressProbe(pi: { registerTool: (tool: unknown) => void }): void {
  pi.registerTool({
    name: "progress_probe",
    label: "Progress probe",
    description: "Test-only tool: reports progress once, then returns PROBE_DONE.",
    promptSnippet: "Test-only tool.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute(_id: string, _params: unknown, _signal: unknown, onUpdate?: (partial: unknown) => void) {
      onUpdate?.({ content: [{ type: "text", text: "halfway" }], details: {} });
      return { content: [{ type: "text", text: "PROBE_DONE" }], details: {} };
    },
  });
}

describe("a session listener that throws on a progress update (real SDK, faux model)", () => {
  const ws = mkdtempSync(join(tmpdir(), "pi-guard-real-ws-"));
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

  async function runProbe(listener: (event: AgentSessionEvent) => void): Promise<{
    toolResult: ToolResult | undefined;
    last: { role?: string; stopReason?: string; errorMessage?: string } | undefined;
  }> {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("progress_probe", {})),
      fauxAssistantMessage(fauxText("done")),
    ]);
    const services = await createAgentSessionServices({
      cwd: ws,
      agentDir: home,
      modelRuntime: runtime,
      resourceLoaderOptions: { extensionFactories: [progressProbe as never], noContextFiles: true },
    });
    const model = resolveCliModel({ cliModel: "faux/faux-1", modelRuntime: services.modelRuntime }).model;
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(ws), model });
    await session.bindExtensions({});
    const off = session.subscribe(listener);
    try {
      await session.prompt("call the probe");
      await session.waitForIdle();
    } catch {
      /* 整轮出错时 prompt 可能直接拒绝；看工具结果 */
    } finally {
      off();
      session.dispose();
    }
    const messages = session.messages as Array<ToolResult & { stopReason?: string; errorMessage?: string }>;
    return {
      toolResult: messages.find((m) => m.role === "toolResult" && m.toolName === "progress_probe"),
      last: messages.at(-1),
    };
  }

  const throwOnProgress = (event: AgentSessionEvent): void => {
    if (event.type === "tool_execution_update") throw new Error("listener broke");
  };

  it("unguarded: execute succeeded, yet its result is lost and the turn ends in an error (the SDK behaviour this guards against)", async () => {
    const { toolResult, last } = await runProbe(throwOnProgress);
    expect(toolResult).toBeUndefined();
    expect(last).toMatchObject({ role: "assistant", stopReason: "error", errorMessage: "listener broke" });
  });

  it("guarded: the tool result is the tool's own", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { toolResult, last } = await runProbe(guardListener("probe listener", throwOnProgress));
      expect(toolResult?.isError).not.toBe(true);
      expect(resultText(toolResult)).toBe("PROBE_DONE");
      expect(last).toMatchObject({ role: "assistant", stopReason: "stop" });
      expect(log.mock.calls[0]?.[0]).toBe("[session-listener] probe listener failed; swallowed so the session keeps going");
    } finally {
      log.mockRestore();
    }
  });
});
