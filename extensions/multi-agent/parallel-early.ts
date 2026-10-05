import type { NormalizedTask } from "./tasks.js";
import { closedParallelTasks } from "./tasks.js";

export interface EarlySlot {
  task: string;
  ok: boolean;
  output: string;
  error?: string;
  partial?: boolean;
  agentId?: string;
  sessionPath?: string;
  stopReason?: string;
  model?: string;
  settled: boolean;
}

export interface EarlyBatch {
  raw: string;
  slots: EarlySlot[];
  runs: Array<Promise<void>>;
  abortors: AbortController[];
}

const byId = new Map<string, EarlyBatch>();
const indexToId = new Map<number, string>();

export function rememberSpawnTool(contentIndex: number, id: string): EarlyBatch {
  const existing = byId.get(id);
  if (existing) {
    indexToId.set(contentIndex, id);
    return existing;
  }
  const batch: EarlyBatch = { raw: "", slots: [], runs: [], abortors: [] };
  byId.set(id, batch);
  indexToId.set(contentIndex, id);
  return batch;
}

export function appendSpawnDelta(contentIndex: number, delta: string): { batch: EarlyBatch; tasks: NormalizedTask[] } | undefined {
  const id = indexToId.get(contentIndex);
  if (!id) return undefined;
  const batch = byId.get(id);
  if (!batch) return undefined;
  batch.raw += delta;
  return { batch, tasks: closedParallelTasks(batch.raw) };
}

export function rekeySpawnTool(contentIndex: number, id: string): void {
  const prev = indexToId.get(contentIndex);
  if (!prev || prev === id) {
    indexToId.set(contentIndex, id);
    return;
  }
  const batch = byId.get(prev);
  if (!batch) return;
  byId.delete(prev);
  byId.set(id, batch);
  indexToId.set(contentIndex, id);
}

/** execute() 接手这批已经开工的任务。没有对应流式批次时返回 undefined。 */
export function adoptSpawnBatch(toolCallId: string): EarlyBatch | undefined {
  const batch = byId.get(toolCallId);
  if (!batch) return undefined;
  byId.delete(toolCallId);
  for (const [index, id] of indexToId) {
    if (id === toolCallId) indexToId.delete(index);
  }
  return batch;
}

export function __resetEarlySpawnForTest(): void {
  byId.clear();
  indexToId.clear();
}
