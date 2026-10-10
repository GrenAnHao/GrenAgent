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
  thinkingLevel: string | null;
  sessionPath: string | null;
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

  /**
   * 项目内的子代理登记。给了 ownerSessionPath 时只返回这份会话派出去的（含子代理再派的孙级）：
   * 登记的 parentId 是发起会话的 sessionId。老库没有 parentId 列，归不到任何会话。
   */
  list(workspace: string, ownerSessionPath?: string): SubagentItem[] {
    const db = this.openRegistry(workspace);
    if (!db) return [];
    try {
      if (!hasTable(db, 'subagents')) return [];
      const sessionColumn = hasColumn(db, 'subagents', 'sessionPath');
      const parentColumn = hasColumn(db, 'subagents', 'parentId');
      const owner = ownerSessionPath?.trim();
      if (owner && !parentColumn) return [];
      const thinkingColumn = hasColumn(db, 'subagents', 'thinkingLevel');
      const columns = `${sessionColumn ? ', sessionPath' : ''}${parentColumn ? ', parentId' : ''}`;
      const select = `SELECT id, task, status, model${thinkingColumn ? ', thinkingLevel' : ''}, output, error, exitCode, createdAt, updatedAt, profile${columns} FROM subagents`;
      let rows: Array<Record<string, unknown>>;
      if (owner) {
        // 先只拿归属要用的短列（有 idx_subagents_listing 时不碰表行），收出归属于这份会话的 id 后，
        // 再按主键取这几行的完整列。整表扫带大 transcript 的行在主线程上一次上百毫秒。
        const skeleton = db.prepare(`SELECT id${columns} FROM subagents ORDER BY createdAt DESC LIMIT ?`)
          .all(OWNED_SCAN_LIMIT) as Array<Record<string, unknown>>;
        const ids = rowsOwnedBy(skeleton, sessionIdFromFileName(owner)).slice(0, LIST_LIMIT).map((row) => asString(row.id));
        if (ids.length === 0) return [];
        const full = db.prepare(`${select} WHERE id IN (${ids.map(() => '?').join(', ')})`).all(...ids) as Array<Record<string, unknown>>;
        const byId = new Map(full.map((row) => [asString(row.id), row]));
        rows = ids.map((id) => byId.get(id)).filter((row): row is Record<string, unknown> => Boolean(row));
      } else {
        rows = db.prepare(`${select} ORDER BY createdAt DESC LIMIT ?`).all(LIST_LIMIT) as Array<Record<string, unknown>>;
      }
      return rows.map((row) => ({
        id: asString(row.id),
        task: asString(row.task),
        status: asString(row.status),
        model: asNullableString(row.model),
        thinkingLevel: thinkingColumn ? asNullableString(row.thinkingLevel) : null,
        sessionPath: sessionColumn ? asNullableString(row.sessionPath) : null,
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
    return sampleCatalogRow(identityFromChildMeta(path));
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

const LIST_LIMIT = 50;
/** 按会话筛时多看一些行：同项目别的会话的记录会挤占最新 50 条。 */
const OWNED_SCAN_LIMIT = 500;

/** Pi 会话文件名是 `<时间戳>_<sessionId>.jsonl`；子代理会话的 sessionId 就是它的 agentId。 */
function sessionIdFromFileName(path: string | null | undefined): string {
  const name = (path ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  return name.match(/^\d{4}-\d{2}-\d{2}T[^_]+_(.+)\.jsonl$/)?.[1] ?? '';
}

/** 从根会话顺着 parentId 往下收：子代理再派的孙级挂在子代理自己的 sessionId 下。保持传入顺序。 */
function rowsOwnedBy(rows: Array<Record<string, unknown>>, rootSessionId: string): Array<Record<string, unknown>> {
  if (!rootSessionId) return [];
  const owners = new Set([rootSessionId]);
  const picked = new Set<Record<string, unknown>>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (picked.has(row)) continue;
      const parent = asNullableString(row.parentId);
      if (!parent || !owners.has(parent)) continue;
      picked.add(row);
      owners.add(asString(row.id));
      const childSession = sessionIdFromFileName(asNullableString(row.sessionPath));
      if (childSession) owners.add(childSession);
      grew = true;
    }
  }
  return rows.filter((row) => picked.has(row));
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

const MAX_WHITELIST_DEPTH = 8;

function catalogWhitelist(parentSessionPath: string): Map<string, SubagentCatalogEntry> {
  const map = new Map<string, SubagentCatalogEntry>();
  const visited = new Set<string>([parentSessionPath]);
  const walk = (path: string, depth: number): void => {
    if (depth > MAX_WHITELIST_DEPTH) return;
    let entries: SubagentCatalogEntry[] = [];
    try {
      entries = foldCatalog(path).entries;
    } catch {
      return;
    }
    for (const child of entries) {
      if (visited.has(child.sessionPath)) continue;
      visited.add(child.sessionPath);
      map.set(child.sessionPath, child);
      walk(child.sessionPath, depth + 1);
    }
  };
  walk(parentSessionPath, 1);
  return map;
}

function identityFromChildMeta(sessionPath: string): SubagentCatalogEntry {
  const meta = peekChildMeta(sessionPath);
  const fallbackId = basename(sessionPath).replace(/\.jsonl$/i, '');
  const agentId = typeof meta?.agentId === 'string' && meta.agentId.trim() ? meta.agentId.trim() : fallbackId;
  const label = typeof meta?.label === 'string' && meta.label.trim() ? meta.label : '(untitled)';
  return {
    id: agentId,
    sessionPath,
    createdAt: typeof meta?.createdAt === 'number' && Number.isFinite(meta.createdAt) ? meta.createdAt : 0,
    mode: meta?.mode === 'continuable' ? 'continuable' : 'one-shot',
    label,
  };
}

function peekChildMeta(sessionPath: string): Record<string, unknown> | undefined {
  try {
    if (!sessionPath || !existsSync(sessionPath)) return undefined;
    return lastSubagentMeta(SessionManager.open(sessionPath).getEntries());
  } catch {
    return undefined;
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
