import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { flattenTranscript } from "../_shared/transcript.js";
import { type AskFn, askLlm, parseJsonLoose, resolveModel } from "./llm.js";
import { LOCAL_MEMORY_EXTRACT_SYSTEM, formatExtractionPrompt, messagesFromTranscript } from "./prompts.js";
import type { MemoryScope } from "./store.js";

export interface CaptureClient {
  request<T>(method: string, params: Record<string, unknown>): Promise<T>;
}

type CaptureContext = Pick<ExtensionContext, "model" | "modelRegistry" | "signal"> & MemoryScope & { extract?: boolean };
type AskFactory = (ctx: CaptureContext) => AskFn | undefined;

type ExtractionWrite = { level: 1 | 2 | 3; content: string };

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
    const captured = await this.client.request<{ changed: boolean; delta: string; taskId?: string; extraction?: string }>("memory.capture", { ...scope(ctx), source, transcript, fingerprint, ...(ctx.extract === false ? { extract: false } : {}) });
    if (!captured.changed || !captured.delta) return;
    if (ctx.extract === false) return;
    // Electron-owned MemoryService queues, defers or skips extraction itself. The
    // local fallback below remains for older sidecars that return neither.
    if (captured.taskId || captured.extraction) return;
    const delta = captured.delta;

    const ask = this.askFactory(ctx);
    if (!ask) return;
    let writes: ExtractionWrite[] | undefined;
    try {
      writes = parseFallbackExtraction(await ask(SYSTEM, formatExtractionPrompt({
        newMessages: messagesFromTranscript(delta),
      })), source);
    } catch {
      return;
    }
    if (!writes) return;
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

function parseFallbackExtraction(raw: string, source: string): ExtractionWrite[] | undefined {
  const parsed = parseJsonLoose(raw);
  if (parsed === undefined) return undefined;
  if (Array.isArray(parsed)) {
    return flattenSceneRecords(parsed).map((record) => ({ level: 1 as const, content: JSON.stringify(record) }));
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const extracted = parsed as Record<string, unknown>;
  if (Object.keys(extracted).some((key) => !['l1', 'l2', 'l3'].includes(key))) return undefined;
  if (extracted.l2 !== undefined && typeof extracted.l2 !== 'string') return undefined;
  if (extracted.l3 !== undefined && typeof extracted.l3 !== 'string') return undefined;
  const writes: ExtractionWrite[] = [];
  if (extracted.l1 !== undefined) {
    if (!Array.isArray(extracted.l1)) return undefined;
    for (const record of flattenSceneRecords([{ scene_name: '未分类', memories: extracted.l1 }])) {
      writes.push({ level: 1, content: JSON.stringify(record) });
    }
  }
  if (typeof extracted.l2 === 'string' && extracted.l2.trim()) writes.push({ level: 2, content: markdown(extracted.l2, source) });
  if (typeof extracted.l3 === 'string' && extracted.l3.trim()) writes.push({ level: 3, content: markdown(extracted.l3, source) });
  return writes;
}

function flattenSceneRecords(scenes: unknown[]): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  for (const item of scenes) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const scene = item as Record<string, unknown>;
    const sceneName = typeof scene.scene_name === 'string' && scene.scene_name.trim() ? scene.scene_name : '未分类';
    if (!Array.isArray(scene.memories)) continue;
    for (const memory of scene.memories) {
      if (!memory || typeof memory !== 'object' || Array.isArray(memory)) continue;
      const rec = memory as Record<string, unknown>;
      if (typeof rec.content !== 'string' || !rec.content.trim() || typeof rec.type !== 'string' || !rec.type.trim()) continue;
      records.push({
        content: rec.content.trim(),
        type: rec.type,
        priority: typeof rec.priority === 'number' ? rec.priority : 50,
        scene_name: typeof rec.scene_name === 'string' && rec.scene_name.trim() ? rec.scene_name : sceneName,
        source_message_ids: Array.isArray(rec.source_message_ids) ? rec.source_message_ids.filter((id): id is string => typeof id === 'string') : [],
        metadata: rec.metadata && typeof rec.metadata === 'object' && !Array.isArray(rec.metadata) ? rec.metadata : {},
      });
    }
  }
  return records;
}

function hash(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
}
