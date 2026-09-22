import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AuditExport, AuditPage, AuditQuery, AuditView, ResourceRef } from './operationsContracts';
import { operationResource, operationText } from './operationsProjection';

const sensitiveKey = (key: string) => /token|apikey|secret|credential|password|authorization/i.test(key.replace(/[^a-z0-9]/gi, ''));

/** Key-based redaction, not a promise to detect secrets in arbitrary prose. */
export function redactAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuditValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sensitiveKey(key) ? '[redacted]' : redactAuditValue(entry)]));
}

type Projection = { [key: string]: 'identifier' | 'model' | 'project' | 'pagePath' | 'text' | 'count' | 'boolean' | 'list' | Projection };
const resourceFields: Projection = { type: 'identifier', id: 'identifier' };
const targetFields: Projection = { ...resourceFields, kind: 'identifier', kbId: 'identifier', pageId: 'pagePath', sourceId: 'identifier' };
const commonFields: Projection = { resource: resourceFields, resourceName: 'text', target: targetFields };
const jobFields: Projection = { ...commonFields, id: 'identifier', kind: 'identifier', workspace: 'project', stage: 'text', processed: 'count', total: 'count', progress: 'count', state: 'identifier', retryOf: 'identifier', error: 'text', ids: 'list',
  metadata: { target: targetFields, resource: resourceFields, resourceName: 'text', retryOf: 'identifier', payload: { kbId: 'identifier', sourceIds: 'list' } } };

function project(value: Record<string, unknown>, fields: Projection): Record<string, unknown> {
  const entries: Array<[string, unknown]> = [];
  for (const [key, entry] of Object.entries(value)) {
    if (sensitiveKey(key)) { entries.push([key, '[redacted]']); continue; }
    const field = fields[key];
    if (!field) continue;
    if (field === 'count' && Number.isSafeInteger(entry) && Number(entry) >= 0) {
      entries.push([key, entry]);
    } else if (field === 'boolean' && typeof entry === 'boolean') {
      entries.push([key, entry]);
    } else if (field === 'list' && Array.isArray(entry)) {
      entries.push([key, entry.slice(0, 500).map((item) => operationText(item, 'identifier')).filter((item) => item !== undefined)]);
    } else if (typeof field === 'object' && entry && typeof entry === 'object' && !Array.isArray(entry)) {
      entries.push([key, project(entry as Record<string, unknown>, field)]);
    } else if (field === 'identifier' || field === 'model' || field === 'project' || field === 'pagePath' || field === 'text') {
      const text = operationText(entry, key === 'id' && value.type === 'project' ? 'project' : field);
      if (text !== undefined) entries.push([key, key === 'error' ? text.slice(0, 200) : text]);
    }
  }
  return Object.fromEntries(entries);
}

const actionLabels: Record<string, string> = {
  'job.create': '创建任务', 'job.stage': '更新任务阶段', 'job.cancel_requested': '请求取消任务', 'job.cancel': '取消任务', 'job.complete': '任务完成', 'job.fail': '任务失败', 'job.remove': '移除任务记录', 'job.clear': '清理任务记录',
  'config.update': '更新配置', 'data.import': '导入配置', 'memory.create': '创建记忆', 'memory.update': '更新记忆', 'memory.remove': '移除记忆',
};

interface AuditRow { id: string; action: string; detail: string; created_at: number; resource_type: ResourceRef['type'] | null; resource_id: string | null }
interface Cursor { version: 1; createdAt: number; id: string; filterHash: string }
interface Selection { action?: string; resource?: ResourceRef; from?: number; to?: number; limit: number; cursor?: Cursor; filterHash: string }

function selection(input: AuditQuery): Selection {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_AUDIT_QUERY: invalid audit query');
  if (input.action !== undefined && (typeof input.action !== 'string' || !input.action.trim() || input.action.length > 128)) throw new Error('INVALID_AUDIT_QUERY: invalid audit action');
  if (input.resource !== undefined && !operationResource(input.resource)) throw new Error('INVALID_AUDIT_QUERY: invalid audit resource');
  for (const key of ['from', 'to'] as const) if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || input[key]! < 0)) throw new Error(`INVALID_AUDIT_QUERY: invalid audit ${key}`);
  if (input.from !== undefined && input.to !== undefined && input.from > input.to) throw new Error('INVALID_AUDIT_QUERY: invalid audit time range');
  if (input.limit !== undefined && (typeof input.limit !== 'number' || !Number.isFinite(input.limit))) throw new Error('INVALID_AUDIT_QUERY: invalid audit limit');
  const filters = { action: input.action, resource: input.resource ? { type: input.resource.type, id: input.resource.id } : undefined, from: input.from, to: input.to };
  const filterHash = createHash('sha256').update(JSON.stringify(filters)).digest('hex');
  let cursor: Cursor | undefined;
  if (input.cursor !== undefined) {
    try {
      if (typeof input.cursor !== 'string' || !/^[a-zA-Z0-9_-]{1,2048}$/.test(input.cursor)) throw new Error();
      const parsed = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as Cursor;
      if (!parsed || parsed.version !== 1 || !Number.isSafeInteger(parsed.createdAt) || parsed.createdAt < 0 || typeof parsed.id !== 'string' || !parsed.id || parsed.id.length > 256 || parsed.filterHash !== filterHash) throw new Error();
      cursor = parsed;
    } catch { throw new Error('INVALID_AUDIT_CURSOR: invalid audit cursor'); }
  }
  return { ...filters, filterHash, cursor, limit: Math.max(1, Math.min(100, Math.trunc(input.limit ?? 50))) };
}

// Resource inference is shared by SQL filtering and the returned projection.
const resourceCases = [
  ...['resource', 'target', 'metadata.resource', 'metadata.target'].map((path) => ({
    when: `json_extract(metadata,'$.${path}.type') IN ('wiki','project','memory') AND json_type(metadata,'$.${path}.id')='text' AND json_extract(metadata,'$.${path}.id')!=''`,
    type: `json_extract(metadata,'$.${path}.type')`, id: `json_extract(metadata,'$.${path}.id')`,
  })),
  ...['kbId', 'target.kbId', 'metadata.payload.kbId'].map((path) => ({
    when: `action GLOB 'job.*' AND json_type(metadata,'$.${path}')='text' AND json_extract(metadata,'$.${path}')!=''`, type: "'wiki'", id: `json_extract(metadata,'$.${path}')`,
  })),
  { when: "(action GLOB 'job.*' OR action GLOB 'code.*' OR action GLOB 'project.*') AND json_type(metadata,'$.workspace')='text' AND json_extract(metadata,'$.workspace')!=''", type: "'project'", id: "json_extract(metadata,'$.workspace')" },
  { when: "action GLOB 'memory.*' AND json_type(metadata,'$.id')='text' AND json_extract(metadata,'$.id')!=''", type: "'memory'", id: "json_extract(metadata,'$.id')" },
];
const resourceSql = (field: 'type' | 'id') => `CASE ${resourceCases.map((entry) => `WHEN ${entry.when} THEN ${entry[field]}`).join(' ')} ELSE NULL END`;

export class AuditViewStore {
  constructor(private readonly db: DatabaseSync) {}

  query(input: AuditQuery = {}): AuditPage {
    const selected = selection(input); const rows = this.read(selected, selected.limit + 1, true);
    const items = rows.slice(0, selected.limit).map((row) => this.view(row));
    const last = rows[selected.limit - 1];
    return { items, ...(rows.length > selected.limit ? { nextCursor: Buffer.from(JSON.stringify({ version: 1, createdAt: last.created_at, id: last.id, filterHash: selected.filterHash })).toString('base64url') } : {}) };
  }

  /** Export starts at the beginning of the current filter, never at a page cursor. */
  export(input: AuditQuery = {}): AuditExport {
    const selected = selection(input); const rows = this.read(selected, 501, false);
    return { items: rows.slice(0, 500).map((row) => this.view(row)), limit: 500, truncated: rows.length > 500 };
  }

  private read(selected: Selection, limit: number, useCursor: boolean): AuditRow[] {
    const conditions: string[] = []; const params: Array<string | number> = [];
    if (selected.action !== undefined) { conditions.push('action=?'); params.push(selected.action); }
    if (selected.resource) { conditions.push('resource_type=? AND resource_id=?'); params.push(selected.resource.type, selected.resource.id); }
    if (selected.from !== undefined) { conditions.push('created_at>=?'); params.push(selected.from); }
    if (selected.to !== undefined) { conditions.push('created_at<=?'); params.push(selected.to); }
    if (useCursor && selected.cursor) { conditions.push('(created_at<? OR (created_at=? AND id<?))'); params.push(selected.cursor.createdAt, selected.cursor.createdAt, selected.cursor.id); }
    return this.db.prepare(`WITH normalized AS (SELECT *,CASE WHEN json_valid(detail) THEN detail ELSE '{}' END AS metadata FROM agent_audit),
      resources AS (SELECT *,${resourceSql('type')} AS resource_type,${resourceSql('id')} AS resource_id FROM normalized)
      SELECT id,action,detail,created_at,resource_type,resource_id FROM resources ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY created_at DESC,id DESC LIMIT ?`).all(...params, limit) as unknown as AuditRow[];
  }

  private view(row: AuditRow): AuditView {
    let detail: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.detail) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      let fields = commonFields;
      if (row.action.startsWith('job.')) fields = jobFields;
      else if (row.action === 'config.update') fields = { ...commonFields, module: 'identifier', version: 'count' };
      else if (row.action === 'data.import') fields = { ...commonFields, modules: 'count' };
      detail = redactAuditValue(project(parsed as Record<string, unknown>, fields)) as Record<string, unknown>;
    } catch { detail = { parseError: '审计元数据无法解析' }; }
    const resource = operationResource({ type: row.resource_type, id: row.resource_id });
    const metadata = detail.metadata as Record<string, unknown> | undefined;
    let snapshot: string | undefined;
    if (typeof detail.resourceName === 'string') snapshot = detail.resourceName;
    else if (typeof metadata?.resourceName === 'string') snapshot = metadata.resourceName;
    const summary = `${actionLabels[row.action] ?? '审计操作'}${typeof detail.error === 'string' ? `：${detail.error}` : ''}`;
    return { id: row.id, action: row.action, summary, ...(resource ? { resource, resourceName: snapshot || `资源已移除（${resource.id}）` } : {}), detail, createdAt: Number(row.created_at) };
  }
}
