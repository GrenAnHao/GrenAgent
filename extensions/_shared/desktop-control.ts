import { getConfig } from './runtime-config.js';
import { MemoryClient } from '../memory/client.js';

export interface DesktopControlPort {
  request<T>(method: string, params: Record<string, unknown>): Promise<T>;
}

export function desktopControl(): DesktopControlPort {
  return new MemoryClient();
}

export async function authorizeDesktopOperation(
  client: DesktopControlPort,
  operation: Record<string, unknown>,
): Promise<{ status: 'allowed' | 'denied' | 'blocked' }> {
  try {
    return await client.request('permission.authorize', {
      operation,
      profile: getConfig('PI_PERMISSION_PROFILE') ?? 'workspace',
    });
  } catch {
    return { status: 'denied' };
  }
}

export type ToolOrigin = 'main' | 'subagent' | 'goal';
export type ToolEffect = 'allow' | 'deny' | 'ask';
export type ApprovalPreset = 'ask' | 'auto' | 'full';
export type RuleScope = 'session' | 'workspace' | 'global';
export type MatcherKind = 'any' | 'command_prefix' | 'path_glob' | 'mcp_server';
export type AuditResolution = 'auto' | 'rule' | 'user_allow' | 'user_deny' | 'queued' | 'aborted';

export interface ToolCallFlags {
  dangerousCommand: boolean;
  mutatingCommand: boolean;
  protectedPath: boolean;
  outsideWorkspace: boolean;
  network: boolean;
  mcp: boolean;
  codeExec: boolean;
  write: boolean;
}

export interface ToolCallFacts {
  tool: string;
  workspace: string;
  origin: ToolOrigin;
  preset: ApprovalPreset;
  flags: ToolCallFlags;
  sessionId?: string;
  toolCallId?: string;
  command?: string;
  path?: string;
  rawArgs?: Record<string, unknown>;
}

export interface ToolRuleDraft {
  scope: RuleScope;
  scopeKey: string;
  tool: string;
  matcherKind: MatcherKind;
  matcher: string;
  effect: ToolEffect;
  expiresAt?: number;
}

export interface ToolDecisionResult {
  decision: ToolEffect;
  auditId?: string;
  ruleId?: string;
}

/** 判定本进程身份，与 extensions/goal/tools.ts 的 automaticTurn 同源。 */
export function resolveToolOrigin(): ToolOrigin {
  if (process.env.PI_IS_SUBAGENT === '1') return 'subagent';
  if (process.env.PI_GOAL_WORKER === '1' || process.env.PI_SYSTEM_WORKER === '1') return 'goal';
  return 'main';
}

/**
 * 问主进程这次工具调用能不能执行。
 *
 * 通道不可用或回包不合法时返回 deny：此时既无法确认规则也无法写审计，
 * 放行等于无记录地执行。不要改成 allow。
 */
export async function evaluateToolCall(
  client: DesktopControlPort,
  call: ToolCallFacts,
): Promise<ToolDecisionResult> {
  try {
    const result = await client.request<unknown>('permission.tool.evaluate', { call });
    if (typeof result !== 'object' || result === null) return { decision: 'deny', auditId: undefined };
    const value = result as { decision?: unknown; auditId?: unknown; ruleId?: unknown };
    if (value.decision !== 'allow' && value.decision !== 'deny' && value.decision !== 'ask') {
      return { decision: 'deny', auditId: undefined };
    }
    return {
      decision: value.decision,
      auditId: typeof value.auditId === 'string' ? value.auditId : undefined,
      ...(typeof value.ruleId === 'string' ? { ruleId: value.ruleId } : {}),
    };
  } catch {
    return { decision: 'deny', auditId: undefined };
  }
}

/** 用户选「总是允许」后落规则。失败只影响下次还会再问一遍，不阻断本次执行。 */
export async function rememberToolRule(client: DesktopControlPort, rule: ToolRuleDraft): Promise<boolean> {
  try {
    await client.request('permission.tool.remember', { rule });
    return true;
  } catch {
    return false;
  }
}

/** 回填用户应答。审计写失败不改变已经作出的放行/拦截决定，故吞掉异常。 */
export async function settleToolCall(
  client: DesktopControlPort,
  auditId: string | undefined,
  resolution: AuditResolution,
): Promise<void> {
  if (!auditId) return;
  try {
    await client.request('permission.tool.settle', { auditId, resolution });
  } catch {
    /* 审计回填失败不影响本次执行结果 */
  }
}
