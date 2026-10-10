import { digestArgs } from './argsDigest';
import { SUBAGENT_ASK_PINNED_RULE_ID } from '../../../../extensions/_shared/delegation-scope.js';
import { matchBuiltinRules } from './builtinRules';
import { matchUserRules } from './rules';
import type { AuditResolution, ToolAuditStore } from './auditStore';
import { EFFECT_RANK } from './effectRank';
import type { ToolRuleStore } from './ruleStore';
import type { ToolCallFacts, ToolDecision, ToolEffect, ToolRule, ToolRuleInput } from './types';

/** goal / subagent 没有交互 UI，ask 只能攒进队列等人处理。 */
function isHeadless(call: ToolCallFacts): boolean {
  return call.origin !== 'main';
}

export class ToolDecisionService {
  constructor(
    private readonly rules: Pick<ToolRuleStore, 'applicable' | 'add'>,
    private readonly audit: ToolAuditStore,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * 决定这次工具调用能不能执行，并留下审计记录。
   *
   * 内置规则与用户规则各选出最强的一条后再比一次，因此用户的 allow 既解除不了
   * 内置 deny，也降不掉内置 ask。规则查询失败时降级为 ask 而非放行。
   */
  evaluate(call: ToolCallFacts): ToolDecision {
    // 审批档表和 safety 扩展都在 agent-host 子进程里：facts.preset 是扩展在工具调用那一刻现读的，
    // 对话中切档已经包含在内。主进程这边没有这张表，不能再拿它覆盖。
    const facts = call;
    const builtin = matchBuiltinRules(facts);
    let user: ToolRule | undefined;
    let lookupFailed = false;
    try {
      user = matchUserRules(this.rules.applicable(call.workspace, call.sessionId), call, this.now());
    } catch {
      lookupFailed = true;
    }

    let decision: ToolEffect = 'allow';
    let ruleId: string | undefined;
    let resolution: AuditResolution = 'auto';

    if (lookupFailed) {
      decision = 'ask';
      ruleId = 'builtin.rule-lookup-failed';
    } else if (builtin && (!user || EFFECT_RANK[builtin.effect] >= EFFECT_RANK[user.effect])) {
      decision = builtin.effect;
      ruleId = builtin.id;
    } else if (user) {
      decision = user.effect;
      ruleId = user.id;
      resolution = 'rule';
    }

    // 子级没有交互 UI，也没有事后放行重跑的机制：ask 钉死为 deny，审计仍留 auto 行。
    if (decision === 'ask' && call.origin === 'subagent') {
      decision = 'deny';
      ruleId = SUBAGENT_ASK_PINNED_RULE_ID;
      resolution = 'auto';
    }
    if (decision === 'ask') resolution = 'queued';

    const auditId = this.audit.record({
      workspace: call.workspace,
      origin: call.origin,
      tool: call.tool,
      args: digestArgs(call.tool, call.rawArgs),
      decision,
      resolution,
      ...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }),
      ...(call.threadId === undefined ? {} : { threadId: call.threadId }),
      ...(call.turnId === undefined ? {} : { turnId: call.turnId }),
      ...(call.toolCallId === undefined ? {} : { toolCallId: call.toolCallId }),
      ...(ruleId === undefined ? {} : { ruleId }),
      ...(decision === 'ask' && isHeadless(call)
        ? { queuePayload: JSON.stringify({ tool: call.tool, command: call.command, path: call.path, ruleId }) }
        : {}),
    });

    return { decision, auditId, ...(ruleId === undefined ? {} : { ruleId }) };
  }

  /** 用户选「总是允许」后落一条规则。 */
  remember(input: ToolRuleInput): ToolRule {
    return this.rules.add(input);
  }

  /** 用户应答或中断后更新审计行。 */
  settle(auditId: string, resolution: AuditResolution): boolean {
    return this.audit.resolve(auditId, resolution);
  }
}
