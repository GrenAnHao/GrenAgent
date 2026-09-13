import { existsSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { SessionManager } from '../../../cli/src/pi-sdk.js';
import type { SandboxManager } from './sandbox/sandboxManager';

export interface SubagentItem {
  id: string;
  task: string;
  status: string;
  model: string | null;
  profile: string | null;
  output: string | null;
  error: string | null;
  exitCode: number | null;
  transcript: string | null;
  createdAt: number;
  updatedAt: number;
}

export class SubagentService {
  constructor(private readonly sandbox?: SandboxManager) {}

  list(workspace: string): SubagentItem[] {
    const db = this.openRegistry(workspace);
    if (!db) return [];
    try {
      if (!hasTable(db, 'subagents')) return [];
      const rows = db.prepare(`SELECT id, task, status, model, output, error, exitCode, createdAt, updatedAt, profile
        FROM subagents ORDER BY createdAt DESC LIMIT ?`).all(50) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        id: asString(row.id),
        task: asString(row.task),
        status: asString(row.status),
        model: asNullableString(row.model),
        profile: asNullableString(row.profile),
        output: asNullableString(row.output),
        error: asNullableString(row.error),
        exitCode: asNullableNumber(row.exitCode),
        transcript: null,
        createdAt: asNumber(row.createdAt),
        updatedAt: asNumber(row.updatedAt),
      }));
    } finally {
      db.close();
    }
  }

  transcript(workspace: string, agentId: string): string | null {
    const id = agentId.trim();
    if (!id) throw new Error('agentId is required');
    const db = this.openRegistry(workspace);
    if (!db) return null;
    try {
      if (!hasColumn(db, 'subagents', 'transcript')) return null;
      const row = db.prepare('SELECT transcript FROM subagents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      return row ? asNullableString(row.transcript) : null;
    } finally {
      db.close();
    }
  }

  /** Read-only: load LLM context messages from a child sub-agent session JSONL (no parent session switch). */
  sessionMessages(sessionPath: string): unknown[] {
    const path = sessionPath.trim();
    if (!path || !existsSync(path)) return [];
    try {
      const sm = SessionManager.open(path);
      return sm.buildSessionContext().messages as unknown[];
    } catch {
      return [];
    }
  }

  async cancel(workspace: string, agentId: string): Promise<void> {
    const id = agentId.trim();
    if (!id) throw new Error('agentId is required');
    const directory = subagentsDir(workspace);
    this.sandbox?.prepare({ profile: 'workspace', workspaceRoot: workspace, cwd: workspace, writePaths: [directory] });
    await mkdir(directory, { recursive: true });
    await appendFile(join(directory, 'cancel-requests.jsonl'), `${JSON.stringify({ agentId: id, at: Date.now() })}\n`);
  }

  private openRegistry(workspace: string): DatabaseSync | null {
    const path = join(subagentsDir(workspace), 'registry.db');
    if (!existsSync(path)) return null;
    const db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 500');
    return db;
  }
}

function subagentsDir(workspace: string): string {
  return join(workspace, '.pi', 'subagents');
}

function hasTable(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>;
  return rows.some((row) => row.name === column);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}
