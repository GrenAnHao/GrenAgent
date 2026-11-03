// 实跑（不联网）：真实 AgentSession + gpt-with-taste + fable-behavior，模型换成 faux 的 gpt-* 模型。
// 验证三件只看单测看不出来的事：
//   1. 请求里真带上了 <gpt-with-taste> 段（走 Pi 的 context_with_system → provider 请求）；
//   2. 这一段不落进会话日志（换轮、后台唤醒不会重复累积）；
//   3. fable-behavior 在 gpt 模型上让位，切到非 gpt 模型又回来。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pi-taste-agent-"));
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
import { fauxAssistantMessage, fauxProvider, fauxText, type FauxResponseStep } from "@earendil-works/pi-ai";
import fableBehavior from "../fable-behavior/index.js";
import gptWithTaste from "./index.js";

type Msg = { role: string; content: unknown; sections?: Record<string, string | null> };

const LF = String.fromCharCode(10);
const JOIN = [LF, "---", LF].join("");

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
    .join(LF);
}

/** 把 faux 收到的请求原文拼成一条字符串，供断言（含前导 system 消息的 sections）。 */
function promptText(context: { messages: readonly Msg[] }): string {
  return context.messages
    .map((message) => {
      const sections = Object.values(message.sections ?? {}).filter(
        (value): value is string => typeof value === "string",
      );
      return [textOf(message.content), ...sections].join(LF);
    })
    .join(JOIN);
}

describe("gpt-with-taste on a real session (faux model)", () => {
  const ws = mkdtempSync(join(tmpdir(), "pi-taste-ws-"));
  const faux = fauxProvider({
    provider: "faux",
    models: [
      { id: "gpt-6.1-sol", input: ["text"] },
      { id: "claude-opus-5", input: ["text"] },
    ],
  });
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

  async function start(modelId: string) {
    const services = await createAgentSessionServices({
      cwd: ws,
      agentDir: home,
      modelRuntime: runtime,
      resourceLoaderOptions: {
        // 顺序对齐 allExtensions：fable-behavior 在前，gpt-with-taste 在后。
        extensionFactories: [fableBehavior as never, gptWithTaste as never],
        noContextFiles: true,
      },
    });
    const model = resolveCliModel({ cliModel: `faux/${modelId}`, modelRuntime: services.modelRuntime }).model;
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(ws),
      model,
    });
    await session.bindExtensions({ uiContext: { notify: () => {}, setStatus: () => {} } as never });
    return session;
  }

  function record(seen: string[], reply: FauxResponseStep): FauxResponseStep {
    return (context, ...rest) => {
      seen.push(promptText(context as { messages: readonly Msg[] }));
      return typeof reply === "function" ? (reply as (...a: unknown[]) => never)(context, ...rest) : reply;
    };
  }

  it("puts the taste block in the request without storing it in the transcript", async () => {
    const seen: string[] = [];
    faux.setResponses([
      record(seen, fauxAssistantMessage(fauxText("ok"))),
      record(seen, fauxAssistantMessage(fauxText("ok again"))),
    ]);
    const session = await start("gpt-6.1-sol");
    try {
      await session.prompt("first", { source: "rpc" } as never);
      await session.waitForIdle();
      await session.prompt("second", { source: "rpc" } as never);
      await session.waitForIdle();

      expect(seen).toHaveLength(2);
      for (const prompt of seen) expect(prompt).toContain("<gpt-with-taste>");
      // 第二轮请求里只有一份整块文本（没跟着历史累积）。
      expect(seen[1].match(/<gpt-with-taste>/g)).toHaveLength(1);
      expect(seen[1]).toContain("<gpt-with-taste-user-steer>");
      // 文本是请求期投影：会话日志里没有。
      const stored = JSON.stringify(session.messages);
      expect(stored).not.toContain("<gpt-with-taste>");
      expect(stored).not.toContain("gpt-with-taste:steer");
      // fable 让位。
      expect(stored).not.toContain("[Fable Behavior]");
    } finally {
      session.dispose();
    }
  });

  it("leaves a non-gpt model to fable-behavior", async () => {
    const seen: string[] = [];
    faux.setResponses([record(seen, fauxAssistantMessage(fauxText("ok")))]);
    const session = await start("claude-opus-5");
    try {
      await session.prompt("hello", { source: "rpc" } as never);
      await session.waitForIdle();
      expect(seen[0]).not.toContain("<gpt-with-taste>");
      expect(JSON.stringify(session.messages)).toContain("[Fable Behavior]");
    } finally {
      session.dispose();
    }
  });

  it("/taste off hands the turn back to fable-behavior", async () => {
    const seen: string[] = [];
    faux.setResponses([record(seen, fauxAssistantMessage(fauxText("ok")))]);
    const session = await start("gpt-6.1-sol");
    try {
      // 等价于用户在输入框敲 /taste off：状态写在会话分支上。
      session.sessionManager.appendCustomEntry("gpt-with-taste:state", { enabled: false });
      await session.prompt("hello", { source: "rpc" } as never);
      await session.waitForIdle();
      expect(seen[0]).not.toContain("<gpt-with-taste>");
      expect(JSON.stringify(session.messages)).toContain("[Fable Behavior]");
    } finally {
      session.dispose();
    }
  });
});
