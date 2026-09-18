import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { flattenTranscript } from "../_shared/transcript.js";
import { type AskFn, askLlm, parseJsonLoose, resolveModel } from "./llm.js";
import { LOCAL_MEMORY_EXTRACT_SYSTEM } from "./prompts.js";
import type { MemoryScope } from "./store.js";

export interface CaptureClient {
  request<T>(method: string, params: Record<string, unknown>): Promise<T>;
}

type CaptureContext = Pick<ExtensionContext, "model" | "modelRegistry" | "signal"> & MemoryScope & { extract?: boolean };
type AskFactory = (ctx: CaptureContext) => AskFn | undefined;

interface Extraction {
  l1?: unknown;
  l2?: string;
  l3?: string;
}

const SYSTEM = LOCAL_MEMORY_EXTRACT_SYSTEM;

export class LayeredMemoryCapture {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly client: CaptureClient, private readonly askFactory: AskFactory = defaultAsk) {}

  enqueue(ctx: CaptureContext, messages: unknown[]): Promise<void> {
    const run = this.tail.then(() => this.capture(ctx, messages));
    this.tail = run.catch(() => {});
    return run;
  }

  private async capture(ctx: CaptureContext, messages: unknown[]): Promise<void> {
    const transcript = flattenTranscript(messages, Infinity);
    if (!transcript) return;
    const fingerprint = hash(transcript);
    const source = `session:${ctx.sessionId ?? "unknown"}`;
    const captured = await this.client.request<{ changed: boolean; delta: string; taskId?: string }>("memory.capture", { ...scope(ctx), source, transcript, fingerprint, ...(ctx.extract === false ? { extract: false } : {}) });
    if (!captured.changed || !captured.delta) return;
    if (ctx.extract === false) return;
    // Electron-owned MemoryService queues extraction in the system worker. The
    // local fallback below remains for older sidecars that do not return taskId.
    if (captured.taskId) return;
    const delta = captured.delta;

    const ask = this.askFactory(ctx);
    if (!ask) return;
    let extracted: Extraction | undefined;
    try {
      extracted = parseJsonLoose<Extraction>(await ask(SYSTEM, delta));
    } catch {
      return;
    }
    if (!extracted || typeof extracted !== "object" || Array.isArray(extracted)) return;
    if (Object.keys(extracted).some((key) => !['l1', 'l2', 'l3'].includes(key))) return;
    if (extracted.l1 !== undefined && (!extracted.l1 || typeof extracted.l1 !== 'object')) return;
    if (extracted.l2 !== undefined && typeof extracted.l2 !== 'string') return;
    if (extracted.l3 !== undefined && typeof extracted.l3 !== 'string') return;

    const writes: Array<{ level: 1 | 2 | 3; content: string }> = [];
    if (extracted.l1 !== undefined) {
      const content = JSON.stringify(extracted.l1);
      if (content && content !== "{}" && content !== "[]") writes.push({ level: 1, content });
    }
    if (typeof extracted.l2 === "string" && extracted.l2.trim()) writes.push({ level: 2, content: markdown(extracted.l2, source) });
    if (typeof extracted.l3 === "string" && extracted.l3.trim()) writes.push({ level: 3, content: markdown(extracted.l3, source) });
    try {
      for (const write of writes) await this.client.request("memory.upsert", { ...scope(ctx), ...write, source });
      await this.client.request("memory.commitCapture", { ...scope(ctx), source, fingerprint });
    } catch {
      // Keep the cursor pending so a later agent_end retries extraction.
    }
  }
}

function defaultAsk(ctx: CaptureContext): AskFn | undefined {
  const model = resolveModel(ctx.model, ctx.modelRegistry, undefined);
  return model ? (system, user) => askLlm(model, system, user, ctx.signal) : undefined;
}

function scope(ctx: MemoryScope): Record<string, unknown> {
  return { userId: ctx.userId, workspace: ctx.workspace, ...(ctx.projectId ? { projectId: ctx.projectId } : {}), ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}) };
}

function markdown(content: string, source: string): string {
  return `> Source: ${source}\n\n${content.trim()}`;
}

function hash(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
}
