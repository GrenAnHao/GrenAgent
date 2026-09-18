import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { parseJobMetadata } from './jobStore';
import { operationResource, operationText } from './operationsProjection';
import type { TaskDetail, TaskListInput, TaskPage, TaskRef, TaskView } from './operationsContracts';

const labels: Record<string, string> = { 'wiki.sync': 'Wiki 同步', 'wiki.ingest': 'Wiki 资料提取', 'codegraph.sync': '代码索引同步', wiki_page_generate: 'Wiki 页面生成', memory_extract: '记忆提取', memory_deduplicate: '记忆去重', memory_scene: '记忆场景', memory_persona: '记忆原则', memory_consolidate: '记忆整理' };
const stages = new Set(['已选择资料', '正在选择资料', '正在扫描', '正在读取', '正在生成', '正在发布', '已处理', '正在构建', '已完成']);
const active = new Set(['pending', 'queued', 'running', 'blocked']);
interface Cursor { v: 1; updatedAt: number; source: TaskRef['source']; id: string; filterHash: string; signature: string }
type Row = Record<string, unknown>;

export class TaskViewStore {
  private readonly cursorKey = randomBytes(32);
  constructor(private readonly db: DatabaseSync) {}

  list(input: TaskListInput = {}): TaskPage {
    if (input.source !== undefined && !['user', 'system'].includes(input.source)) throw new Error('INVALID_TASK_SOURCE');
    if (input.group !== undefined && !['active', 'history'].includes(input.group)) throw new Error('INVALID_TASK_GROUP');
    if ((input.workspace !== undefined && typeof input.workspace !== 'string') || (input.query !== undefined && typeof input.query !== 'string')) throw new Error('INVALID_TASK_FILTER');
    const query = input.query?.trim() ?? '';
    const filterHash = createHash('sha256').update(JSON.stringify([input.source ?? null, input.group ?? null, input.workspace ?? null, query])).digest('hex');
    const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(100, Math.trunc(input.limit!))) : 50;
    const conditions: string[] = []; const parameters: SQLInputValue[] = [];
    if (input.source) { conditions.push('source=?'); parameters.push(input.source); }
    if (input.group) conditions.push(`status ${input.group === 'active' ? 'IN' : 'NOT IN'} ('pending','queued','running','blocked')`);
    if (input.workspace !== undefined) { conditions.push('workspace=?'); parameters.push(input.workspace); }
    if (query) {
      conditions.push("(id LIKE ? ESCAPE '\\' OR kind LIKE ? ESCAPE '\\' OR label LIKE ? ESCAPE '\\' OR resource_name LIKE ? ESCAPE '\\' OR workspace LIKE ? ESCAPE '\\')");
      const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`; parameters.push(pattern, pattern, pattern, pattern, pattern);
    }
    const activeConditions = ["status IN ('pending','queued','running','blocked')", ...conditions];
    const activeParameters = [...parameters];
    if (input.cursor !== undefined) {
      const cursor = this.decodeCursor(input.cursor, filterHash);
      conditions.push('(updated_at < ? OR (updated_at = ? AND (source > ? OR (source = ? AND id > ?))))');
      parameters.push(cursor.updatedAt, cursor.updatedAt, cursor.source, cursor.source, cursor.id);
    }
    const union = this.union();
    const rows = this.db.prepare(`SELECT * FROM (${union}) ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY updated_at DESC,source ASC,id ASC LIMIT ?`).all(...parameters, limit + 1) as Row[];
    const activeCount = Number(this.db.prepare(`SELECT count(*) AS count FROM (${union}) WHERE ${activeConditions.join(' AND ')}`).get(...activeParameters)!.count);
    const hasMore = rows.length > limit; const selected = rows.slice(0, limit);
    const last = selected.at(-1);
    return { items: selected.map((row) => this.map(row)), activeCount, ...(hasMore && last ? { nextCursor: this.encodeCursor(last, filterHash) } : {}) };
  }

  read(ref: TaskRef): TaskView | undefined {
    assertRef(ref);
    const row = this.db.prepare(`SELECT * FROM (${this.union()}) WHERE source=? AND id=?`).get(ref.source, ref.id) as Row | undefined;
    return row ? this.map(row) : undefined;
  }

  readDetail(ref: TaskRef): TaskDetail | undefined {
    const view = this.read(ref); if (!view) return undefined;
    const detail: TaskDetail = { ...view, events: [] };
    if (ref.source === 'system') {
      const input = "CASE WHEN json_valid(input) THEN input ELSE '{}' END";
      const output = "CASE WHEN json_valid(output) THEN output ELSE '{}' END";
      const row = this.db.prepare(`SELECT json_extract(${input},'$.kbId') AS kbId,json_extract(${input},'$.sourceId') AS sourceId,
        json_extract(${input},'$.sourceRevision') AS sourceRevision,json_extract(${input},'$.expectedModel') AS model,
        json_extract(${output},'$.succeeded') AS succeeded,json_extract(${output},'$.skipped') AS skipped,
        json_extract(${output},'$.failed') AS failed,json_extract(${output},'$.generated') AS generated FROM service_tasks WHERE id=?`).get(ref.id) as Row;
      if (this.hasTable('wiki_task_targets')) {
        const target = this.db.prepare("SELECT kb_id,source_id FROM wiki_task_targets WHERE task_source='service_task' AND task_id=? ORDER BY kb_id,source_id LIMIT 1").get(ref.id);
        if (target) { row.kbId = target.kb_id; if (target.source_id) row.sourceId = target.source_id; }
      }
      detail.inputSummary = safeSummary(row, ['kbId', 'sourceId', 'model'], ['sourceRevision']);
      detail.outputSummary = safeSummary(row, [], ['succeeded', 'skipped', 'failed', 'generated']);
    } else {
      const row = this.db.prepare('SELECT metadata FROM agent_jobs WHERE id=?').get(ref.id);
      const metadata = parseJobMetadata(row?.metadata);
      detail.inputSummary = { ...(view.resource ? { resource: view.resource } : {}), ...(view.workspace ? { workspace: view.workspace } : {}) };
      if (metadata?.payload && 'sourceIds' in metadata.payload) detail.inputSummary.sourceCount = metadata.payload.sourceIds.length;
      if (this.hasTable('wiki_ingest_runs')) {
        const run = this.db.prepare("SELECT model,CASE WHEN json_valid(summary) THEN summary ELSE '{}' END AS summary FROM wiki_ingest_runs WHERE job_id=?").get(ref.id);
        if (run) {
          Object.assign(detail.inputSummary, safeSummary(run, ['model'], []));
          detail.outputSummary = safeSummary(JSON.parse(String(run.summary)), [], ['succeeded', 'skipped', 'failed']);
        }
      }
      const audit = "CASE WHEN json_valid(detail) THEN detail ELSE '{}' END";
      const events = this.db.prepare(`SELECT id,action,created_at,json_extract(${audit},'$.stage') AS stage FROM agent_audit
        WHERE action IN ('job.stage','job.cancel_requested','job.cancel','job.cancel_failed') AND json_extract(${audit},'$.id')=?
        ORDER BY created_at DESC,id DESC LIMIT 100`).all(ref.id) as Row[];
      detail.events = events.map((event) => {
        let message = '执行器已确认取消';
        if (event.action === 'job.stage') message = safeStage(event.stage) ?? '任务阶段已更新';
        else if (event.action === 'job.cancel_requested') message = '已请求取消，等待执行器确认';
        else if (event.action === 'job.cancel_failed') message = '取消请求失败，可再次尝试';
        return { id: String(event.id), action: String(event.action), createdAt: Number(event.created_at), message };
      });
    }
    return detail;
  }

  private union(): string {
    const metadata = "CASE WHEN json_valid(j.metadata) THEN j.metadata ELSE '{}' END";
    const label = (alias: string) => `CASE ${alias}.kind ${Object.entries(labels).map(([kind, name]) => `WHEN '${kind}' THEN '${name}'`).join(' ')} ELSE ${alias}.kind END`;
    const lease = this.hasTable('wiki_task_targets') ? "EXISTS(SELECT 1 FROM wiki_task_targets t WHERE t.task_source='agent_job' AND t.task_id=j.id AND t.active=1)" : '0';
    const user = `SELECT 'user' AS source,j.id,j.kind,${label('j')} AS label,j.workspace,j.state AS status,j.progress,j.error,j.metadata,
      CASE WHEN json_type(${metadata},'$.resourceName')='text' THEN json_extract(${metadata},'$.resourceName') END AS resource_name,
      NULL AS kb_id,NULL AS attempts,${lease} AS active_lease,j.created_at,j.updated_at FROM agent_jobs j`;
    if (!this.hasTable('service_tasks')) return user;
    const input = "CASE WHEN json_valid(s.input) THEN s.input ELSE '{}' END";
    const target = this.hasTable('wiki_task_targets') ? "(SELECT t.kb_id FROM wiki_task_targets t WHERE t.task_source='service_task' AND t.task_id=s.id ORDER BY t.kb_id LIMIT 1)" : 'NULL';
    return `${user} UNION ALL SELECT 'system' AS source,s.id,s.kind,${label('s')} AS label,s.source_project_id AS workspace,s.status,NULL AS progress,
      s.error,NULL AS metadata,NULL AS resource_name,COALESCE(${target},CASE WHEN json_type(${input},'$.kbId')='text' THEN json_extract(${input},'$.kbId') END) AS kb_id,
      s.attempts,0 AS active_lease,s.created_at,s.updated_at FROM service_tasks s`;
  }

  private map(row: Row): TaskView {
    const source = row.source as TaskRef['source']; const metadata = parseJobMetadata(row.metadata);
    const corrupt = source === 'user' && row.metadata != null && metadata === undefined;
    const kind = String(row.kind); const status = String(row.status) as TaskView['status'];
    const workspace = operationText(row.workspace, 'project');
    let resource: TaskView['resource'];
    if (source === 'user') {
      resource = operationResource(metadata?.target);
      if (!resource && workspace && ['wiki.sync', 'codegraph.sync'].includes(kind)) resource = { type: 'project', id: workspace };
    } else {
      resource = operationResource({ type: 'wiki', id: row.kb_id });
      if (!resource && workspace) resource = { type: 'project', id: workspace };
    }
    const measurable = source === 'user' && kind !== 'codegraph.sync' && metadata?.processed !== undefined && metadata.total !== undefined && metadata.total > 0 && metadata.processed <= metadata.total;
    let error: string | undefined;
    if (corrupt) error = '任务元数据损坏，已使用安全视图';
    else if (row.error) error = safeError(row.error);
    else if (metadata?.cancellationError) error = '取消请求失败，可再次尝试';
    return { ref: { source, id: String(row.id) }, key: `${source}:${row.id}`, kind, label: String(row.label), status, workspace, resource,
      resourceName: operationText(metadata?.resourceName, 'text'), stage: safeStage(metadata?.stage) ?? (source === 'user' && kind === 'codegraph.sync' && status === 'running' ? '正在构建' : undefined),
      progress: measurable ? Math.round(metadata.processed! / metadata.total! * 100) : undefined,
      processed: source === 'user' ? metadata?.processed : undefined, total: source === 'user' ? metadata?.total : undefined,
      cancellationRequested: source === 'user' && metadata?.cancellationRequested === true, retryOf: operationText(metadata?.retryOf, 'identifier'),
      attempts: source === 'system' ? Number(row.attempts) : undefined,
      error,
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      capabilities: { cancel: false, retry: false, remove: source === 'user' && !active.has(status) && !Boolean(row.active_lease) } };
  }

  private hasTable(table: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)); }
  private encodeCursor(row: Row, filterHash: string): string {
    const cursor = { v: 1 as const, updatedAt: Number(row.updated_at), source: row.source as TaskRef['source'], id: String(row.id), filterHash };
    return Buffer.from(JSON.stringify({ ...cursor, signature: this.sign(cursor) })).toString('base64url');
  }
  private sign(cursor: Omit<Cursor, 'signature'>): string { return createHmac('sha256', this.cursorKey).update(JSON.stringify(cursor)).digest('hex'); }
  private decodeCursor(value: string, filterHash: string): Cursor {
    try {
      if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
      const parsed = JSON.parse(Buffer.from(value, 'base64url').toString()) as Cursor;
      if (parsed.v !== 1 || !Number.isSafeInteger(parsed.updatedAt) || !['user', 'system'].includes(parsed.source) || typeof parsed.id !== 'string' || !parsed.id || parsed.filterHash !== filterHash || !/^[0-9a-f]{64}$/.test(parsed.signature)) throw new Error();
      const expected = this.sign({ v: 1, updatedAt: parsed.updatedAt, source: parsed.source, id: parsed.id, filterHash });
      if (!timingSafeEqual(Buffer.from(expected), Buffer.from(parsed.signature))) throw new Error();
      return parsed;
    } catch { throw new Error('INVALID_TASK_CURSOR'); }
  }
}

function assertRef(ref: TaskRef): void { if (!ref || !['user', 'system'].includes(ref.source) || typeof ref.id !== 'string' || !ref.id) throw new Error('INVALID_TASK_REF'); }
function safeStage(value: unknown): string | undefined { return typeof value === 'string' && stages.has(value) ? value : undefined; }
function safeError(value: unknown): string {
  const code = typeof value === 'string' ? value.match(/^(MODEL_UNAVAILABLE|MODEL_CHANGED|WIKI_INGEST_INTERRUPTED|SOURCE_CHANGED|VERSION_CONFLICT)\b/)?.[1] : undefined;
  return code ? `${code}：任务执行未完成` : '任务执行失败，请检查相关配置与审计';
}
function safeSummary(value: unknown, strings: string[], counts: string[]): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return summary;
  const row = value as Row;
  for (const key of strings) { const text = operationText(row[key], key === 'model' ? 'model' : 'identifier'); if (text !== undefined) summary[key] = text; }
  for (const key of counts) if (Number.isSafeInteger(row[key]) && Number(row[key]) >= 0) summary[key] = Number(row[key]);
  return summary;
}
