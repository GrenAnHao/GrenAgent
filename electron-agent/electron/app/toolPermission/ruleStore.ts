import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { normalizeComparablePath } from './paths';
import type { MatcherKind, RuleScope, ToolEffect, ToolRule, ToolRuleInput } from './types';

// 判别字段在库里就是普通字符串，这里的断言不做运行时校验：脏数据（版本回退、手改库）
// 由消费方兜住——rules.ts 的 scopeApplies 与 matcherApplies 对未知取值一律不匹配，
// matchUserRules 还用 hasOwn 挡掉未知 effect。在这一层拦截只会让一行坏数据连累整次读取。
function mapRow(row: Record<string, unknown>): ToolRule {
  return {
    id: String(row.id),
    scope: String(row.scope) as RuleScope,
    scopeKey: String(row.scope_key ?? ''),
    tool: String(row.tool),
    matcherKind: String(row.matcher_kind) as MatcherKind,
    matcher: String(row.matcher ?? ''),
    effect: String(row.effect) as ToolEffect,
    createdAt: Number(row.created_at),
    ...(row.expires_at === null || row.expires_at === undefined ? {} : { expiresAt: Number(row.expires_at) }),
  };
}

export class ToolRuleStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  add(input: ToolRuleInput): ToolRule {
    const rule: ToolRule = { ...input, id: randomUUID(), createdAt: this.now() };
    this.db
      .prepare(
        `INSERT INTO permission_rules (id, scope, scope_key, tool, matcher_kind, matcher, effect, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rule.id, rule.scope, rule.scopeKey, rule.tool, rule.matcherKind,
        rule.matcher, rule.effect, rule.createdAt, rule.expiresAt ?? null,
      );
    return rule;
  }

  /**
   * 按创建顺序返回全部规则，最早的在前。
   *
   * 这个顺序会决定同分规则的取舍：matchUserRules 用严格 > 比较排名，因此强度与作用域
   * 完全相同的两条规则里先创建的那条胜出。决策结果不受影响（同强度必然同 effect），
   * 但审计行记下的 ruleId 是哪一条由此决定——改排序就会改变审计里报告的规则 id。
   */
  list(): ToolRule[] {
    return (this.db.prepare('SELECT * FROM permission_rules ORDER BY created_at, rowid').all() as Array<Record<string, unknown>>)
      .map(mapRow);
  }

  /**
   * 取出对这次调用可能适用的规则：全部 global，加上匹配当前工作区与会话的那些。
   * 工作区比较在 SQL 之外做，因为 scope_key 里可能存着不同分隔符或大小写的同一路径。
   *
   * 规范化必须与 rules.ts 的 scopeApplies 用同一个 normalizeComparablePath：这里是
   * 预筛，比那边更严就会把本该匹配的规则提前丢掉，而且丢得无声无息。历史上就差在
   * 尾部分隔符——scopeKey 写成 D:/repo/ 的工作区规则会在这一步被滤掉。
   */
  applicable(workspace: string, sessionId: string | undefined): ToolRule[] {
    const target = normalizeComparablePath(workspace);
    return this.list().filter((rule) => {
      if (rule.scope === 'global') return true;
      if (rule.scope === 'workspace') return normalizeComparablePath(rule.scopeKey) === target;
      return sessionId !== undefined && rule.scopeKey === sessionId;
    });
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM permission_rules WHERE id = ?').run(id).changes > 0;
  }
}
