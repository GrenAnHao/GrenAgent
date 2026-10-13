import { getConfig } from './runtime-config.js';
import { currentWorkspaceContext } from './workspace-context.js';
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
export type ApprovalPreset = 'readonly' | 'ask' | 'auto' | 'workspace' | 'full';
export type RuleScope = 'session' | 'workspace' | 'global';
export type MatcherKind = 'any' | 'command_prefix' | 'path_glob' | 'mcp_server';
export type AuditResolution = 'auto' | 'rule' | 'user_allow' | 'user_deny' | 'queued' | 'aborted' | 'timeout';

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
  /** 子代理能把审批交给父会话的界面（_shared/approval-route.ts）。没有时主进程把子代理的 ask 固定为拒绝。 */
  approvalRoute?: boolean;
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
  /** 通道超时或断开导致的 deny：没有规则参与判定，调用方不该当成「规则拒绝」。 */
  unavailable?: true;
}

/** 连接层的失败（超时、拒连、半路断开）。主进程回了错误帧不算，那是它的判定。 */
const TRANSPORT_CODES = new Set(['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EPIPE']);

function isTransportFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && TRANSPORT_CODES.has(code);
}

/** 判定本进程 / 本回合身份。ALS 优先；无 ALS 时回退子进程 env（fork 与尚未删除的 sidecar）。 */
export function resolveToolOrigin(): ToolOrigin {
  const ctx = currentWorkspaceContext();
  if (ctx) return ctx.origin;
  if (process.env.PI_IS_SUBAGENT === '1') return 'subagent';
  return 'main';
}

/**
 * 问主进程这次工具调用能不能执行。
 *
 * 通道不可用或回包不合法时返回 deny：此时既无法确认规则也无法写审计，
 * 放行等于无记录地执行。不要改成 allow。
 *
 * 主进程和嵌入式 sidecar 共用一个事件循环：它卡住几秒后，到期的客户端计时器会先于
 * 已经能处理的响应触发。所以连接层失败先重试一次，仍失败才 deny，并标上 unavailable。
 */
export async function evaluateToolCall(
  client: DesktopControlPort,
  call: ToolCallFacts,
): Promise<ToolDecisionResult> {
  let result: unknown;
  try {
    result = await client.request<unknown>('permission.tool.evaluate', { call });
  } catch (error) {
    if (!isTransportFailure(error)) return { decision: 'deny', auditId: undefined };
    try {
      result = await client.request<unknown>('permission.tool.evaluate', { call });
    } catch (retryError) {
      return isTransportFailure(retryError)
        ? { decision: 'deny', auditId: undefined, unavailable: true }
        : { decision: 'deny', auditId: undefined };
    }
  }
  try {
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
