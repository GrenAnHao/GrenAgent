import type { DatabaseSync } from 'node:sqlite';
import type { L1Record } from '../agent/memoryExtraction';
import type { MemoryScope } from '../agentData/memoryStore';

export const L2_DELAY_MS = 10_000;
export const L2_MIN_INTERVAL_MS = 900_000;
export const LAYER_SCENE_KIND = 'memory_scene';
export const MAX_PENDING_LAYER_MEMORIES = 200;

export interface LayerSchedulePayload {
  scope: MemoryScope;
  source: string;
  memories: L1Record[];
}

export interface LayerScheduleRow {
  userId: string;
  kind: string;
  lastFiredAt: number;
  fireAt: number | null;
  payload: LayerSchedulePayload | null;
}

export function computeFireAt(now: number, lastFiredAt: number, delayMs: number, minIntervalMs: number): number {
  const delayed = now + delayMs;
  if (lastFiredAt <= 0) return delayed;
  return Math.max(delayed, lastFiredAt + minIntervalMs);
}

export function mergeLayerMemories(existing: L1Record[], incoming: L1Record[]): L1Record[] {
  const merged = [...existing];
  const seen = new Set(existing.map(memoryKey));
  for (const record of incoming) {
    const key = memoryKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(record);
  }
  return merged.length <= MAX_PENDING_LAYER_MEMORIES
    ? merged
    : merged.slice(merged.length - MAX_PENDING_LAYER_MEMORIES);
}

function memoryKey(record: L1Record): string {
  return `${record.content}\0${record.type}\0${record.scene_name}`;
}

export class LayerScheduleStore {
  constructor(private readonly db: DatabaseSync) {}

  ensure(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS memory_layer_schedules (
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      last_fired_at INTEGER NOT NULL DEFAULT 0,
      fire_at INTEGER,
      payload TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, kind)
    )`);
  }

  get(userId: string, kind: string): LayerScheduleRow | undefined {
    const row = this.db.prepare('SELECT user_id,kind,last_fired_at,fire_at,payload FROM memory_layer_schedules WHERE user_id=? AND kind=?')
      .get(userId, kind) as Record<string, unknown> | undefined;
    return row ? mapSchedule(row) : undefined;
  }

  listPending(): LayerScheduleRow[] {
    const rows = this.db.prepare('SELECT user_id,kind,last_fired_at,fire_at,payload FROM memory_layer_schedules WHERE fire_at IS NOT NULL')
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapSchedule);
  }

  upsertPending(input: { userId: string; kind: string; fireAt: number; payload: LayerSchedulePayload; now: number }): LayerScheduleRow {
    const current = this.get(input.userId, input.kind);
    const payload: LayerSchedulePayload = current?.payload
      ? {
          scope: input.payload.scope,
          source: input.payload.source,
          memories: mergeLayerMemories(current.payload.memories, input.payload.memories),
        }
      : input.payload;
    this.db.prepare(`INSERT INTO memory_layer_schedules(user_id,kind,last_fired_at,fire_at,payload,updated_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id,kind) DO UPDATE SET fire_at=excluded.fire_at,payload=excluded.payload,updated_at=excluded.updated_at`)
      .run(input.userId, input.kind, current?.lastFiredAt ?? 0, input.fireAt, JSON.stringify(payload), input.now);
    return this.get(input.userId, input.kind)!;
  }

  markFired(userId: string, kind: string, now: number): void {
    const current = this.get(userId, kind);
    if (!current) {
      this.db.prepare(`INSERT INTO memory_layer_schedules(user_id,kind,last_fired_at,fire_at,payload,updated_at) VALUES(?,?,?,NULL,NULL,?)`)
        .run(userId, kind, now, now);
      return;
    }
    this.db.prepare('UPDATE memory_layer_schedules SET last_fired_at=?,fire_at=NULL,payload=NULL,updated_at=? WHERE user_id=? AND kind=?')
      .run(now, now, userId, kind);
  }

  clearPending(userId: string, kind: string, now: number): void {
    this.db.prepare('UPDATE memory_layer_schedules SET fire_at=NULL,payload=NULL,updated_at=? WHERE user_id=? AND kind=?')
      .run(now, userId, kind);
  }
}

function mapSchedule(row: Record<string, unknown>): LayerScheduleRow {
  return {
    userId: String(row.user_id),
    kind: String(row.kind),
    lastFiredAt: Number(row.last_fired_at),
    fireAt: row.fire_at == null ? null : Number(row.fire_at),
    payload: row.payload == null ? null : JSON.parse(String(row.payload)) as LayerSchedulePayload,
  };
}
