// 实跑（不联网）：真实 AgentSession + auto-title 扩展，模型换成 faux。
// 第一条助手回复结束后标题就落进会话（session_info）；标题模型只看到会话的第一条用户消息，技能块先拆开。

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pi-auto-title-live-agent-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  // 不读开发机上的运行时设置：那里的 AUTO_TITLE 可能是 0。
  process.env.PI_RUNTIME_CONFIG = "";
  delete process.env.AUTO_TITLE;
  delete process.env.titleModel;
  return dir;
});

import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, type FauxResponseStep } from "@earendil-works/pi-ai";
import autoTitle, { __resetAutoTitleForTest } from "./index.js";

describe("auto-title (real SDK, faux model)", () => {
  const ws = mkdtempSync(join(tmpdir(), "pi-auto-title-live-ws-"));
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

  async function start() {
    __resetAutoTitleForTest();
    const services = await createAgentSessionServices({
      cwd: ws,
      agentDir: home,
      modelRuntime: runtime,
      resourceLoaderOptions: { extensionFactories: [autoTitle as never], noContextFiles: true },
    });
    const model = resolveCliModel({ cliModel: "faux/faux-1", modelRuntime: services.modelRuntime }).model;
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(ws), model });
    await session.bindExtensions({ uiContext: { notify: () => {}, setStatus: () => {} } as never });
    return session;
  }

  function sessionName(session: Awaited<ReturnType<typeof start>>): string | undefined {
    const entries = session.sessionManager.getEntries() as Array<{ type?: string; name?: string }>;
    return entries.filter((e) => e.type === "session_info").at(-1)?.name;
  }

  /** 标题请求：系统提示里有起名规则。记下请求文本，回给定的标题。 */
  function titleStep(reply: string, seen: string[]): FauxResponseStep {
    return (context) => {
      // pi 1.3 的请求里系统提示是一条 system 消息，整个上下文转成文本再查。
      seen.push(JSON.parse(JSON.stringify(context.messages)).map((m: { content: unknown }) =>
        typeof m.content === "string" ? m.content : (m.content as Array<{ text?: string }>).map((p) => p.text ?? "").join(""),
      ).join("\n"));
      return fauxAssistantMessage(fauxText(reply));
    };
  }

  it("第一条回复结束后写入清洗过的标题，标题请求只带首条用户消息", async () => {
    const seen: string[] = [];
    faux.setResponses([fauxAssistantMessage(fauxText("好的，我来看看转义是在哪一步发生的")), titleStep("**输入框内容被转义**", seen)]);
    const session = await start();
    try {
      await session.prompt("输入框总是会对一些内容进行转义 这样很烦", { source: "rpc" } as never);
      await session.waitForIdle();
      await vi.waitFor(() => expect(sessionName(session)).toBe("输入框内容被转义"), { timeout: 4000 });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain("Reply with the title only");
      expect(seen[0]).toContain("<request>\n输入框总是会对一些内容进行转义 这样很烦\n</request>");
      expect(seen[0]).not.toContain("我来看看");
    } finally {
      session.dispose();
    }
  });

  it("模型回拒绝句时不写会话名", async () => {
    const seen: string[] = [];
    faux.setResponses([
      fauxAssistantMessage(fauxText("收到")),
      titleStep("无法生成有意义的标题，对话中只有一句话。", seen),
    ]);
    const session = await start();
    try {
      await session.prompt("继续吧", { source: "rpc" } as never);
      await session.waitForIdle();
      await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 4000 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(sessionName(session)).toBeUndefined();
    } finally {
      session.dispose();
    }
  });
});
