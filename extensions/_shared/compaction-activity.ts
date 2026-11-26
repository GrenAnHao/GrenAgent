import { randomUUID } from 'node:crypto';

export type CompactionOrigin = 'policy-auto' | 'user-manual' | 'sdk-threshold' | 'sdk-overflow';
export interface CompactionActivity {
  ownerEpoch: string;
  operationId: string;
  origin: CompactionOrigin;
  phase: 'preparing' | 'running';
  startedAt: number;
  sequence: number;
  contextRevision: number;
}
export interface CompactionIdentity { sessionId: string; sessionPath?: string }
export interface CompactionEvent { type: 'compaction_start' | 'compaction_end'; reason?: string; aborted?: boolean; errorMessage?: string }

interface Entry {
  activity?: CompactionActivity;
  sequence: number;
  contextRevision: number;
  listeners: Set<(activity: CompactionActivity | undefined) => void>;
}
interface Registry { ownerEpoch: string; entries: Map<string, Entry> }
const key = Symbol.for('grenagent.compaction-activity.v1');
const globals = globalThis as typeof globalThis & { [key: symbol]: Registry | undefined };
const registry = globals[key] ??= { ownerEpoch: randomUUID(), entries: new Map() };

function entry(sessionId: string): Entry {
  let current = registry.entries.get(sessionId);
  if (!current) {
    current = { sequence: 0, contextRevision: 0, listeners: new Set() };
    registry.entries.set(sessionId, current);
  }
  return current;
}
function notify(current: Entry): void {
  for (const listener of current.listeners) listener(current.activity);
}

/** Register before ctx.compact(): SDK manual compaction aborts the active request before compaction_start. */
export function beginCompactionIntent(identity: CompactionIdentity, origin: CompactionOrigin): CompactionActivity {
  const current = entry(identity.sessionId);
  if (current.activity) return current.activity;
  const activity: CompactionActivity = {
    ownerEpoch: registry.ownerEpoch, operationId: randomUUID(), origin, phase: 'preparing',
    startedAt: Date.now(), sequence: ++current.sequence, contextRevision: current.contextRevision,
  };
  current.activity = activity;
  notify(current);
  return activity;
}

export function getCompactionActivity(sessionId: string): CompactionActivity | undefined {
  return registry.entries.get(sessionId)?.activity;
}
export function getCompactionContextRevision(sessionId: string): number {
  return registry.entries.get(sessionId)?.contextRevision ?? 0;
}
export function getCompactionOwnerEpoch(): string { return registry.ownerEpoch; }
export function subscribeCompactionActivity(sessionId: string, listener: (activity: CompactionActivity | undefined) => void): () => void {
  const current = entry(sessionId);
  current.listeners.add(listener);
  return () => { current.listeners.delete(listener); };
}

/** A completion may only settle the operation it began; a late callback cannot close a newer operation. */
export function finishCompactionActivity(sessionId: string, operationId: string, success: boolean): void {
  const current = entry(sessionId);
  if (current.activity?.operationId !== operationId) return;
  if (success) current.contextRevision++;
  current.activity = undefined;
  current.sequence++;
  notify(current);
}

/** SDK emits compaction_end after appendCompaction and finalized context refresh on both manual and native paths. */
export function observeCompactionEvent(identity: CompactionIdentity, event: CompactionEvent): CompactionActivity | undefined {
  const current = entry(identity.sessionId);
  if (event.type === 'compaction_start') {
    const origin: CompactionOrigin = event.reason === 'overflow' ? 'sdk-overflow'
      : event.reason === 'threshold' ? 'sdk-threshold' : 'user-manual';
    const pending = current.activity ?? beginCompactionIntent(identity, origin);
    current.activity = { ...pending, phase: 'running', sequence: ++current.sequence };
    notify(current);
    return current.activity;
  }
  const pending = current.activity;
  if (pending) finishCompactionActivity(identity.sessionId, pending.operationId, !event.aborted && !event.errorMessage);
  return pending;
}

/** Host shutdown is an explicit terminal fact, never persist running=true to disk. */
export function forgetCompactionActivity(sessionId: string): void {
  const current = registry.entries.get(sessionId);
  if (!current?.activity) return;
  current.activity = undefined;
  current.sequence++;
  notify(current);
}

export function getCompactionSequence(sessionId: string): number { return registry.entries.get(sessionId)?.sequence ?? 0; }
