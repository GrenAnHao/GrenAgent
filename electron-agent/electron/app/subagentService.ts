import { existsSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { basename, join } from 'node:path';
import { SessionManager } from '../../../cli/src/pi-sdk.js';
import {
  authorizeParent,
  coldResumeAndDeliver,
  deliverToChild,
  getActivationBySessionPath,
  interruptChild as interruptResidentChild,
} from '../../../extensions/multi-agent/activation.js';
import { foldCatalog, type SubagentCatalogEntry, type SubagentCatalogView } from '../../../extensions/multi-agent/catalog.js';
import { sampleCatalogRow, type CatalogRowView } from '../../../extensions/multi-agent/catalog-sample.js';
import type { Delivery } from '../../../extensions/multi-agent/inbox.js';
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

  catalog(parentSessionPath: string): SubagentCatalogView {
    return foldCatalog(parentSessionPath.trim());
  }

  catalogRowSample(sessionPath: string): CatalogRowView {
    const path = sessionPath.trim();
    return sampleCatalogRow({
      id: basename(path),
      sessionPath: path,
      createdAt: 0,
      mode: peekChildMode(path),
      label: '',
    });
  }

  async promptChild(
    workspace: string,
    parentSessionPath: string,
    sessionPath: string,
    message: string,
    delivery: Delivery,
  ): Promise<void> {
    const entry = resolveCatalogChild(parentSessionPath, sessionPath);
    if (entry.mode === 'one-shot') {
      throw new Error('cannot prompt a one-shot child: 只读');
    }
    const activation = getActivationBySessionPath(entry.sessionPath);
    if (activation) {
      authorizeParent(activation, workspace);
      deliverToChild(activation.childId, message, delivery);
      return;
    }
    await coldResumeAndDeliver(entry.id, entry.sessionPath, message, delivery);
  }

  interruptChild(workspace: string, parentSessionPath: string, sessionPath: string): void {
    const entry = resolveCatalogChild(parentSessionPath, sessionPath);
    const activation = getActivationBySessionPath(entry.sessionPath);
    if (!activation) return;
    authorizeParent(activation, workspace);
    interruptResidentChild(activation.childId);
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

function resolveCatalogChild(parentSessionPath: string, sessionPath: string): SubagentCatalogEntry {
  const path = sessionPath.trim();
  const allowed = catalogWhitelist(parentSessionPath.trim());
  const entry = allowed.get(path);
  if (!entry) throw new Error('sessionPath is not in the parent catalog');
  return entry;
}

function catalogWhitelist(parentSessionPath: string): Map<string, SubagentCatalogEntry> {
  const map = new Map<string, SubagentCatalogEntry>();
  const parent = foldCatalog(parentSessionPath);
  for (const child of parent.entries) {
    map.set(child.sessionPath, child);
    for (const grand of foldCatalog(child.sessionPath).entries) {
      map.set(grand.sessionPath, grand);
    }
  }
  return map;
}

function peekChildMode(sessionPath: string): 'one-shot' | 'continuable' {
  try {
    if (!sessionPath || !existsSync(sessionPath)) return 'one-shot';
    const meta = lastSubagentMeta(SessionManager.open(sessionPath).getEntries());
    return meta?.mode === 'continuable' ? 'continuable' : 'one-shot';
  } catch {
    return 'one-shot';
  }
}

function lastSubagentMeta(entries: unknown[]): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  if (!Array.isArray(entries)) return undefined;
  for (const entry of entries) {
    const item = entry as { type?: string; customType?: string; data?: Record<string, unknown> };
    if (item?.type === 'custom' && item.customType === 'subagent_meta' && item.data && typeof item.data === 'object') {
      found = item.data;
    }
  }
  return found;
}
