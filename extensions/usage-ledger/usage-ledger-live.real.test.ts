// 实跑（不联网）：真实 AgentSession + usage-ledger 扩展，模型换成 faux。
// 每条带 usage 的助手消息结束时记一笔账；账本里的键和从会话 jsonl 算出来的键相同，
// 之后历史导入同一份会话不会重复计数。

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pi-usage-ledger-agent-"));
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
import usageLedger from "./index.js";
import { callFromMessage, callKey, defaultLedgerPath, sharedLedger } from "./ledger.js";

function echoTool(pi: { registerTool: (tool: unknown) => void }): void {
  pi.registerTool({
    name: "echo",
    label: "Echo",
    description: "Test-only tool.",
    promptSnippet: "Test-only tool.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      return { content: [{ type: "text", text: "ECHO" }], details: {} };
    },
  });
}

function collect(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? collect(join(dir, e.name)) : e.name.endsWith(".jsonl") ? [join(dir, e.name)] : [],
  );
}

describe("usage-ledger (real SDK, faux model)", () => {
  const ws = mkdtempSync(join(tmpdir(), "pi-usage-ledger-ws-"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  let runtime: ModelRuntime;

  beforeAll(async () => {
    mkdirSync(join(home, "sessions"), { recursive: true });
    runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
  });

  afterAll(() => {
    sharedLedger(defaultLedgerPath(home)).close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("records every assistant call with the same key an import of the session file would use", async () => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", {}), { responseId: "resp_tool" }),
      // 第二条没有 responseId：按会话 id + 消息时间去重。
      fauxAssistantMessage(fauxText("done")),
    ]);
    const services = await createAgentSessionServices({
      cwd: ws,
      agentDir: home,
      modelRuntime: runtime,
      resourceLoaderOptions: { extensionFactories: [echoTool as never, usageLedger as never], noContextFiles: true },
    });
    const model = resolveCliModel({ cliModel: "faux/faux-1", modelRuntime: services.modelRuntime }).model;
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.create(ws), model });
    await session.bindExtensions({ uiContext: { notify: () => {}, setStatus: () => {} } as never });
    try {
      await session.prompt("hello", { source: "rpc" } as never);
      await session.waitForIdle();
    } finally {
      session.dispose();
    }

    const report = sharedLedger(defaultLedgerPath(home)).report();
    expect(report.totals.messages).toBe(2);
    expect(report.totals.totalTokens).toBeGreaterThan(0);
    expect(report.byModel).toEqual([expect.objectContaining({ provider: "faux", model: "faux-1", messages: 2 })]);
    expect(report.recentSessions).toHaveLength(1);
    expect(report.recentSessions[0]).toMatchObject({ cwd: ws, tokens: report.totals.totalTokens });

    // 会话 jsonl 里的同两条调用，算出来的键与账本一致。
    const files = collect(join(home, "sessions"));
    expect(files).toHaveLength(1);
    expect(report.recentSessions[0].path).toBe(files[0]);
    const lines = readFileSync(files[0], "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const header = lines[0];
    const fileKeys = lines
      .filter((e) => e.type === "message")
      .map((e) => callFromMessage(e.message, header.id, e.timestamp))
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .map((c) => callKey(c));
    expect(fileKeys).toHaveLength(2);
    expect(fileKeys[0]).toBe("r:faux:resp_tool");
    expect(fileKeys[1]).toMatch(new RegExp(`^t:${header.id}:[0-9]+$`));
    const ledgerKeys = (sharedLedger(defaultLedgerPath(home)) as unknown as { database: { prepare(sql: string): { all(): Array<{ key: string }> } } })
      .database.prepare("SELECT key FROM calls ORDER BY ts").all().map((r) => r.key);
    expect(ledgerKeys.sort()).toEqual([...fileKeys].sort());
  });
});
