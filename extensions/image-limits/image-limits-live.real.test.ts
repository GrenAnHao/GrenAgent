// 实跑（不联网）：真实 AgentSession + image-limits 扩展，模型换成 faux。
// 回合卡在工具里时 steer 一张 3906px 宽的图：pi 1.3.0 自己不缩 steer 的图，
// 装了扩展后历史里存的、发给模型的都要在 2000×2000 以内。

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pi-image-limits-agent-"));
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
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import imageLimits from "./index.js";
import { isImageBlock, readImageSize } from "./limits.js";

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(width: number, height: number): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  const row = Buffer.alloc(width + 1);
  for (let x = 0; x < width; x++) row[x + 1] = x % 256;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

type Msg = { role: string; content: unknown };
function imageWidths(messages: readonly Msg[]): number[] {
  return messages.flatMap((m) =>
    Array.isArray(m.content) ? m.content.filter(isImageBlock).map((b) => readImageSize(b.data)?.width ?? -1) : [],
  );
}

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

describe("oversized images (real SDK, faux model)", () => {
  const ws = mkdtempSync(join(tmpdir(), "pi-image-limits-ws-"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", input: ["text", "image"] }] });
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

  async function start(withExtension: boolean) {
    const factories = withExtension ? [gateTool as never, imageLimits as never] : [gateTool as never];
    const services = await createAgentSessionServices({
      cwd: ws,
      agentDir: home,
      modelRuntime: runtime,
      resourceLoaderOptions: { extensionFactories: factories, noContextFiles: true },
    });
    const model = resolveCliModel({ cliModel: "faux/faux-1", modelRuntime: services.modelRuntime }).model;
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(ws), model });
    await session.bindExtensions({ uiContext: { notify: () => {}, setStatus: () => {} } as never });
    return session;
  }

  /** 记下发给模型的每条请求里图片的宽度。 */
  function recordWidths(seen: number[][], reply: FauxResponseStep): FauxResponseStep {
    return (context, ...rest) => {
      seen.push(imageWidths(context.messages as Msg[]));
      return typeof reply === "function" ? (reply as (...a: unknown[]) => never)(context, ...rest) : reply;
    };
  }

  async function steerBigImageDuringTool(withExtension: boolean) {
    gated = false;
    const seen: number[][] = [];
    faux.setResponses([
      recordWidths(seen, fauxAssistantMessage(fauxToolCall("gate", {}))),
      recordWidths(seen, fauxAssistantMessage(fauxText("看到了"))),
    ]);
    const session = await start(withExtension);
    try {
      const run = session.prompt("start working", { source: "rpc" } as never);
      await vi.waitUntil(() => gated, { timeout: 4000 });
      // 和 GrenAgent 的 agent_steer 一样：正文为空，只有一张宽图。
      await session.steer("", [{ type: "image", mimeType: "image/png", data: png(3906, 30) }]);
      release();
      await run;
      await session.waitForIdle();
      return { seen, stored: imageWidths(session.messages as Msg[]) };
    } finally {
      release();
      session.dispose();
    }
  }

  it("without the extension pi keeps the steered image at full size (the bug)", async () => {
    const { seen, stored } = await steerBigImageDuringTool(false);
    expect(stored).toEqual([3906]);
    expect(seen.at(-1)).toEqual([3906]);
  });

  it("with the extension the steered image is stored and sent within 2000px", async () => {
    const { seen, stored } = await steerBigImageDuringTool(true);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toBeGreaterThan(0);
    expect(stored[0]).toBeLessThanOrEqual(2000);
    expect(seen.at(-1)).toEqual(stored);
  });

  it("repairs an oversized image that is already in history before the request", async () => {
    const seen: number[][] = [];
    faux.setResponses([recordWidths(seen, fauxAssistantMessage(fauxText("ok")))]);
    const session = await start(true);
    try {
      session.sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "" }, { type: "image", mimeType: "image/png", data: png(3906, 30) }],
        timestamp: 1,
      } as never);
      session.sessionManager.appendMessage(fauxAssistantMessage(fauxText("旧回复")) as never);
      session.agent.state.messages = session.sessionManager.buildSessionContext().messages as never;
      await session.prompt("继续", { source: "rpc" } as never);
      await session.waitForIdle();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toHaveLength(1);
      expect(seen[0][0]).toBeLessThanOrEqual(2000);
      // 历史本身不改，只改发出去的副本。
      expect(imageWidths(session.messages as Msg[])).toEqual([3906]);
    } finally {
      session.dispose();
    }
  });
});
