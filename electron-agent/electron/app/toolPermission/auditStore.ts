import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ToolEffect, ToolOrigin } from './types';

export type AuditResolution = 'auto' | 'rule' | 'user_allow' | 'user_deny' | 'queued' | 'aborted';

export interface ToolAuditInput {
  workspace: string;
  origin: ToolOrigin;
  tool: string;
  args: string;
  decision: ToolEffect;
  resolution: AuditResolution;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  toolCallId?: string;
  ruleId?: string;
  queuePayload?: string;
}

export interface ToolAuditRow extends ToolAuditInput {
  id: string;
  createdAt: number;
  resolvedAt?: number;
}

function optional(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

// 与 ruleStore 同理：origin、decision、resolution 在库里只是字符串，这里的断言不做
// 运行时校验。审计是台账，读回一行坏数据也不该让整次查询失败或把它悄悄抹掉。
function mapRow(row: Record<string, unknown>): ToolAuditRow {
  return {
    id: String(row.id),
    workspace: String(row.workspace),
    origin: String(row.origin) as ToolOrigin,
    tool: String(row.tool),
    args: String(row.args),
    decision: String(row.decision) as ToolEffect,
    resolution: String(row.resolution) as AuditResolution,
    createdAt: Number(row.created_at),
    ...(row.session_id === null || row.session_id === undefined ? {} : { sessionId: String(row.session_id) }),
    ...(row.thread_id === null || row.thread_id === undefined ? {} : { threadId: String(row.thread_id) }),
    ...(row.turn_id === null || row.turn_id === undefined ? {} : { turnId: String(row.turn_id) }),
    ...(row.tool_call_id === null || row.tool_call_id === undefined ? {} : { toolCallId: String(row.tool_call_id) }),
    ...(row.rule_id === null || row.rule_id === undefined ? {} : { ruleId: String(row.rule_id) }),
    ...(optional(row.queue_payload) === undefined ? {} : { queuePayload: String(row.queue_payload) }),
    ...(row.resolved_at === null || row.resolved_at === undefined ? {} : { resolvedAt: Number(row.resolved_at) }),
  };
}

export class ToolAuditStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  /** 写一条决策记录，返回其 id。每次工具调用都要写，无论放行还是拦截。 */
  record(input: ToolAuditInput): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO tool_audit (id, workspace, session_id, thread_id, turn_id, tool_call_id, origin, tool,
           args, decision, resolution, rule_id, queue_payload, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id, input.workspace, input.sessionId ?? null, input.threadId ?? null, input.turnId ?? null,
        input.toolCallId ?? null, input.origin, input.tool, input.args, input.decision,
        input.resolution, input.ruleId ?? null, input.queuePayload ?? null, this.now(),
      );
    return id;
  }

  get(id: string): ToolAuditRow | undefined {
    const row = this.db.prepare('SELECT * FROM tool_audit WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : undefined;
  }

  /** 用户或中断给出结果后更新该行。返回是否命中了一行。 */
  resolve(id: string, resolution: AuditResolution): boolean {
    return this.db
      .prepare('UPDATE tool_audit SET resolution = ?, resolved_at = ? WHERE id = ?')
      .run(resolution, this.now(), id).changes > 0;
  }

  /** 无 UI 时攒下的待授权请求，按发生顺序返回。 */
  pending(): ToolAuditRow[] {
    return (this.db
      .prepare("SELECT * FROM tool_audit WHERE resolution = 'queued' ORDER BY created_at, rowid")
      .all() as Array<Record<string, unknown>>).map(mapRow);
  }
}
