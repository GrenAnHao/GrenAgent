import type { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { encodeFrame } from "../_shared/jsonrpc-stdio.js";
import dap from "./index.js";
import { DapConnection } from "./protocol.js";

function mockStdin() {
  const writes: Buffer[] = [];
  const stream = {
    write: (b: Buffer) => {
      writes.push(b);
      return true;
    },
  } as unknown as Writable;
  return { writes, stream };
}

function bodyOf(frame: Buffer): unknown {
  return JSON.parse(frame.toString("utf8").split("\r\n\r\n")[1]);
}

describe("DapConnection", () => {
  it("sends a request frame and resolves on a matching response", async () => {
    const { writes, stream } = mockStdin();
    const conn = new DapConnection(stream);
    const p = conn.request("stackTrace", { threadId: 1 });
    expect(bodyOf(writes[0])).toMatchObject({
      seq: 1,
      type: "request",
      command: "stackTrace",
      arguments: { threadId: 1 },
    });
    conn.feed(
      encodeFrame({ type: "response", request_seq: 1, success: true, command: "stackTrace", body: { ok: 1 } }),
    );
    expect(await p).toEqual({ ok: 1 });
  });

  it("rejects on an unsuccessful response", async () => {
    const { stream } = mockStdin();
    const conn = new DapConnection(stream);
    const p = conn.request("launch");
    conn.feed(
      encodeFrame({ type: "response", request_seq: 1, success: false, command: "launch", message: "boom" }),
    );
    await expect(p).rejects.toThrow("boom");
  });

  it("dispatches events to subscribed handlers", () => {
    const { stream } = mockStdin();
    const conn = new DapConnection(stream);
    const seen: unknown[] = [];
    conn.onEvent("stopped", (b) => seen.push(b));
    conn.feed(encodeFrame({ type: "event", event: "stopped", body: { reason: "breakpoint", threadId: 1 } }));
    expect(seen).toEqual([{ reason: "breakpoint", threadId: 1 }]);
  });

  it("rejectAll fails pending requests", async () => {
    const { stream } = mockStdin();
    const conn = new DapConnection(stream);
    const p = conn.request("continue");
    conn.rejectAll(new Error("exited"));
    await expect(p).rejects.toThrow("exited");
  });
});

describe("dap extension", () => {
  it("returns a text-only result for stack trace without a debug session", async () => {
    const tools: Array<{
      name: string;
      execute: (
        ...args: [
          toolCallId: string,
          params: Record<string, never>,
          signal: AbortSignal | undefined,
          onUpdate: undefined,
          ctx: { cwd: string },
        ]
      ) => Promise<unknown>;
    }> = [];
    const pi = {
      registerTool: (tool: (typeof tools)[number]) => {
        tools.push(tool);
      },
      on: () => {},
    };
    dap(pi as unknown as Parameters<typeof dap>[0]);

    const result = await tools.find((tool) => tool.name === "dap_stack_trace")!.execute(
      "call",
      {},
      undefined,
      undefined,
      { cwd: process.cwd() },
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "无调试会话，请先 dap_launch。" }],
      details: undefined,
    });
  });
});
