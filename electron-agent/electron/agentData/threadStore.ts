import type { DatabaseSync } from 'node:sqlite';
import type { Item, Thread, Turn } from '../app/appServer/types';
import type { AgentDataStorage } from './storage';

export interface ThreadStoreOptions { now?: () => number; }
export interface CreateThreadInput { id: string; projectId: string; workspace: string; title?: string; sessionId?: string; }
export interface CreateTurnInput { id: string; threadId: string; input: string; permissionProfile: string; mode?: Turn['mode']; sessionId?: string; }
export interface ThreadSnapshot { thread: Thread; turns: Turn[]; items: Item[]; }

export class ThreadStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(storage: AgentDataStorage | DatabaseSync, options: ThreadStoreOptions = {}) {
    this.db = 'db' in storage ? storage.db : storage;
    this.now = options.now ?? Date.now;
  }

  createThread(input: CreateThreadInput): Thread {
    const timestamp = this.now();
    const thread: Thread = { ...input, status: 'active', createdAt: timestamp, updatedAt: timestamp };
    this.db.prepare(`INSERT INTO threads (id, project_id, workspace, title, status, created_at, updated_at, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(thread.id, thread.projectId, thread.workspace, thread.title ?? null, thread.status, timestamp, timestamp, thread.sessionId ?? null);
    return thread;
  }

  listThreads(): Thread[] {
    const rows = this.db.prepare('SELECT * FROM threads ORDER BY updated_at DESC, created_at DESC').all() as ThreadRow[];
    return rows.map(toThread);
  }

  readThread(id: string): ThreadSnapshot | undefined {
    const row = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as ThreadRow | undefined;
    if (!row) return undefined;
    const turns = (this.db.prepare('SELECT * FROM turns WHERE thread_id = ? ORDER BY created_at ASC').all(id) as TurnRow[]).map(toTurn);
    const items = (this.db.prepare('SELECT * FROM items WHERE thread_id = ? ORDER BY created_at ASC').all(id) as ItemRow[]).map(toItem);
    return { thread: toThread(row), turns, items };
  }

  createTurn(input: CreateTurnInput): Turn {
    const timestamp = this.now();
    const turn: Turn = { ...input, mode: input.mode ?? 'interactive', status: 'queued', createdAt: timestamp };
    this.db.prepare(`INSERT INTO turns (id, thread_id, status, mode, input, permission_profile, created_at, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(turn.id, turn.threadId, turn.status, turn.mode, turn.input, turn.permissionProfile, timestamp, turn.sessionId ?? null);
    this.touchThread(turn.threadId, timestamp);
    return turn;
  }

  updateTurn(id: string, patch: Partial<Pick<Turn, 'status' | 'startedAt' | 'completedAt' | 'error'>>): Turn {
    const row = this.db.prepare('SELECT * FROM turns WHERE id = ?').get(id) as TurnRow | undefined;
    if (!row) throw new Error(`turn not found: ${id}`);
    const next = { ...toTurn(row), ...patch };
    this.db.prepare('UPDATE turns SET status = ?, started_at = ?, completed_at = ?, error = ? WHERE id = ?')
      .run(next.status, next.startedAt ?? null, next.completedAt ?? null, next.error ?? null, id);
    this.touchThread(next.threadId, this.now());
    return next;
  }

  upsertItem(item: Omit<Item, 'createdAt'> & Partial<Pick<Item, 'createdAt' | 'updatedAt'>>): Item {
    const timestamp = item.createdAt ?? this.now();
    const next: Item = { ...item, createdAt: timestamp, updatedAt: item.updatedAt ?? timestamp };
    this.db.prepare(`INSERT INTO items (id, thread_id, turn_id, type, status, payload, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET type = excluded.type, status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at`)
      .run(next.id, next.threadId, next.turnId, next.type, next.status, JSON.stringify(next.payload), next.createdAt, next.updatedAt);
    this.touchThread(next.threadId, next.updatedAt ?? timestamp);
    return next;
  }

  listItems(threadId: string, turnId?: string): Item[] {
    const rows = (turnId
      ? this.db.prepare('SELECT * FROM items WHERE thread_id = ? AND turn_id = ? ORDER BY created_at ASC').all(threadId, turnId)
      : this.db.prepare('SELECT * FROM items WHERE thread_id = ? ORDER BY created_at ASC').all(threadId)) as ItemRow[];
    return rows.map(toItem);
  }

  private touchThread(id: string, timestamp: number): void { this.db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(timestamp, id); }
}

interface ThreadRow { id: string; project_id: string; workspace: string; title: string | null; status: Thread['status']; created_at: number; updated_at: number; session_id?: string | null; }
interface TurnRow { id: string; thread_id: string; status: Turn['status']; mode: Turn['mode']; input: string; permission_profile: string; created_at: number; started_at: number | null; completed_at: number | null; error: string | null; session_id?: string | null; }
interface ItemRow { id: string; thread_id: string; turn_id: string; type: Item['type']; status: Item['status']; payload: string; created_at: number; updated_at: number | null; }
function toThread(row: ThreadRow): Thread { return { id: row.id, projectId: row.project_id, workspace: row.workspace, ...(row.title === null ? {} : { title: row.title }), status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, ...(row.session_id ? { sessionId: row.session_id } : {}) }; }
function toTurn(row: TurnRow): Turn { return { id: row.id, threadId: row.thread_id, status: row.status, mode: row.mode, input: row.input, permissionProfile: row.permission_profile, createdAt: row.created_at, ...(row.started_at === null ? {} : { startedAt: row.started_at }), ...(row.completed_at === null ? {} : { completedAt: row.completed_at }), ...(row.error === null ? {} : { error: row.error }), ...(row.session_id ? { sessionId: row.session_id } : {}) }; }
function toItem(row: ItemRow): Item { return { id: row.id, threadId: row.thread_id, turnId: row.turn_id, type: row.type, status: row.status, payload: JSON.parse(row.payload), createdAt: row.created_at, ...(row.updated_at === null ? {} : { updatedAt: row.updated_at }) }; }
