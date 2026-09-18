import { describe, expect, it, vi } from "vitest";
import { LayeredMemoryCapture, type CaptureClient } from "./capture.js";

function sceneJson(content: string, extras: Record<string, unknown> = {}): string {
  return JSON.stringify([{
    scene_name: '工作情境',
    message_ids: ['m0'],
    memories: [{ content, type: 'work_fact', priority: 80, source_message_ids: ['m0'], ...extras }],
  }]);
}

const scope = { userId: "local", workspace: "/repo", sessionId: "s1" };
// 只用 model.id 与 modelRegistry.find，按真实参数类型收敛，不复制 pi 的完整结构。
const ctx = {
  ...scope,
  model: { id: "current" },
  modelRegistry: { find: vi.fn() },
  signal: undefined,
} as unknown as Parameters<LayeredMemoryCapture["enqueue"]>[0];

function client(): CaptureClient & { calls: Array<{ method: string; params: Record<string, unknown> }> } {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const cursors = new Map<string, { transcript: string; fingerprint: string; pending?: string }>();
  return {
    calls,
    async request<T>(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      if (method === "memory.capture") {
        const key = `${params.userId}:${params.workspace}:${params.sessionId}:${params.source}`;
        const previous = cursors.get(key);
        const fingerprint = String(params.fingerprint);
        if (previous?.fingerprint === fingerprint && !previous.pending) return { changed: false, delta: "", fingerprint } as T;
        const transcript = String(params.transcript);
        const delta = previous?.fingerprint === fingerprint && previous.pending
          ? previous.pending
          : previous && transcript.startsWith(previous.transcript) ? transcript.slice(previous.transcript.length).replace(/^\n+/, "") : transcript;
        cursors.set(key, { transcript, fingerprint, pending: delta });
        return { changed: true, delta, fingerprint } as T;
      }
      if (method === "memory.captureCommit" || method === "memory.commitCapture") {
        const key = `${params.userId}:${params.workspace}:${params.sessionId}:${params.source}`;
        const previous = cursors.get(key);
        if (previous) previous.pending = undefined;
        return null as T;
      }
      return { id: "id", level: params.level, content: params.content } as T;
    },
  };
}

describe("LayeredMemoryCapture", () => {
  it("serializes agent_end jobs and captures an incremental suffix only once", async () => {
    const c = client();
    let active = 0;
    let peak = 0;
    const ask = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return sceneJson('ok');
    });
    const capture = new LayeredMemoryCapture(c, () => ask);
    const first = capture.enqueue(ctx, [{ role: "user", content: "one" }]);
    const second = capture.enqueue(ctx, [{ role: "user", content: "one" }, { role: "assistant", content: "two" }]);
    await Promise.all([first, second, capture.enqueue(ctx, [{ role: "user", content: "one" }, { role: "assistant", content: "two" }])]);
    expect(peak).toBe(1);
    expect(c.calls.filter((x) => x.method === "memory.capture")).toHaveLength(3);
    expect(c.calls.find((x) => x.method === "memory.capture")?.params.transcript).toContain("one");
    expect(c.calls.filter((x) => x.method === "memory.capture")[1].params.transcript).toContain("assistant: two");
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("uses the current model, tolerates fenced JSON, and stores referenced markdown layers", async () => {
    const c = client();
    const ask = vi.fn(async () => `noise\n\`\`\`json\n${sceneJson('ship it')}\n\`\`\`\n`);
    const capture = new LayeredMemoryCapture(c, (value) => {
      expect(value.model).toBe(ctx.model);
      expect(value.modelRegistry).toBe(ctx.modelRegistry);
      return ask;
    });
    await capture.enqueue(ctx, [{ role: "user", content: "ship it" }]);
    const levels = c.calls.filter((x) => x.method === "memory.upsert").map((x) => x.params);
    expect(levels.find((x) => x.level === 1)?.content).toContain('"content":"ship it"');
    expect(levels.find((x) => x.level === 1)?.content).toContain('"type":"work_fact"');
    expect(ask.mock.calls[0]?.[1]).toContain('【待提取的新消息】');
    expect(ask.mock.calls[0]?.[1]).toContain('ship it');
  });

  it("accepts JSON strings containing closing braces", async () => {
    const c = client();
    const capture = new LayeredMemoryCapture(c, () => async () => `${sceneJson('brace } is text')} trailing`);
    await capture.enqueue(ctx, [{ role: "user", content: "quoted brace" }]);
    expect(c.calls.find((x) => x.method === "memory.upsert" && x.params.level === 1)?.params.content).toContain("brace }");
  });

  it("keeps existing extracted layers when the LLM fails", async () => {
    const c = client();
    await c.request("memory.upsert", { ...scope, level: 1, content: "old", source: "session:s1" });
    const capture = new LayeredMemoryCapture(c, () => async () => { throw new Error("offline"); });
    await capture.enqueue(ctx, [{ role: "user", content: "new" }]);
    expect(c.calls.filter((x) => x.method === "memory.upsert" && x.params.level !== 0)).toHaveLength(1);
  });

  it("retries extraction for the same cursor after a failed model call", async () => {
    const c = client();
    let attempts = 0;
    const capture = new LayeredMemoryCapture(c, () => async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
      return sceneJson('ok');
    });
    const messages = [{ role: "user", content: "retry me" }];
    await capture.enqueue(ctx, messages);
    await capture.enqueue(ctx, messages);
    expect(attempts).toBe(2);
    expect(c.calls.filter((x) => x.method === "memory.upsert" && x.params.level === 1)).toHaveLength(1);
  });

  it("does not recapture an already committed cursor after extension recreation", async () => {
    const c = client();
    const messages = [{ role: "user", content: "persisted" }];
    const ask = async () => sceneJson('ok');
    await new LayeredMemoryCapture(c, () => ask).enqueue(ctx, messages);
    const callsBefore = c.calls.length;
    await new LayeredMemoryCapture(c, () => ask).enqueue(ctx, messages);
    expect(c.calls.length - callsBefore).toBe(1);
    expect(c.calls.at(-1)?.method).toBe("memory.capture");
  });

  it("commits a valid empty extraction without retrying it forever", async () => {
    const c = client();
    const ask = vi.fn(async () => '{}');
    const capture = new LayeredMemoryCapture(c, () => ask);
    const messages = [{ role: 'user', content: 'hello' }];
    await capture.enqueue(ctx, messages);
    await capture.enqueue(ctx, messages);
    expect(ask).toHaveBeenCalledOnce();
    expect(c.calls.filter((call) => call.method === 'memory.upsert')).toHaveLength(0);
    expect(c.calls.filter((call) => call.method === 'memory.commitCapture')).toHaveLength(1);
  });

  it("retains the beginning of a cumulative transcript beyond the old tail window", async () => {
    const c = client();
    const capture = new LayeredMemoryCapture(c, () => async () => '{}');
    await capture.enqueue(ctx, [{ role: 'user', content: 'first fact' }, { role: 'assistant', content: 'x'.repeat(13_000) }]);
    expect(c.calls[0].params.transcript).toMatch(/^user: first fact/);
  });

  it("does not call the fallback model when extraction is disabled", async () => {
    const c = client();
    const ask = vi.fn(async () => '{"l1":{"fact":"unused"}}');
    await new LayeredMemoryCapture(c, () => ask).enqueue({ ...ctx, extract: false }, [{ role: 'user', content: 'raw only' }]);
    expect(ask).not.toHaveBeenCalled();
    expect(c.calls[0]).toMatchObject({ method: 'memory.capture', params: { extract: false } });
  });

  it.each(['{"result":"wrong schema"}', '{"l1":"not an object"}', '{"l2":2}', '{"l3":null}'])('keeps malformed extraction %s pending instead of committing it', async (output) => {
    const c = client();
    await new LayeredMemoryCapture(c, () => async () => output).enqueue(ctx, [{ role: 'user', content: 'remember me' }]);
    expect(c.calls.some((call) => call.method === 'memory.commitCapture')).toBe(false);
    expect(c.calls.some((call) => call.method === 'memory.upsert')).toBe(false);
  });
});
