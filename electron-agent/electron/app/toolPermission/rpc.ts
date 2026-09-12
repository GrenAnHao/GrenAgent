import type { AuditResolution } from './auditStore';
import type { ToolDecisionService } from './toolDecisionService';
import type {
  ApprovalPreset, MatcherKind, RuleScope, ToolCallFacts, ToolCallFlags, ToolEffect, ToolOrigin, ToolRuleInput,
} from './types';

type Params = Record<string, unknown>;
type Method = (params: Params) => unknown | Promise<unknown>;

const ORIGINS: readonly ToolOrigin[] = ['main', 'subagent', 'goal'];
const PRESETS: readonly ApprovalPreset[] = ['readonly', 'ask', 'auto', 'workspace', 'full'];
const EFFECTS: readonly ToolEffect[] = ['allow', 'deny', 'ask'];
const SCOPES: readonly RuleScope[] = ['session', 'workspace', 'global'];
const MATCHERS: readonly MatcherKind[] = ['any', 'command_prefix', 'path_glob', 'mcp_server'];
const RESOLUTIONS: readonly AuditResolution[] = ['auto', 'rule', 'user_allow', 'user_deny', 'queued', 'aborted'];

const FLAG_KEYS: readonly (keyof ToolCallFlags)[] = [
  'dangerousCommand', 'mutatingCommand', 'protectedPath', 'outsideWorkspace', 'network', 'mcp', 'codeExec', 'write',
];

function isRecord(value: unknown): value is Params {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`invalid tool call: ${field}`);
  return value;
}

/**
 * 八个特征必须全部到齐，缺一个就拒收整个请求。
 *
 * 不要把缺失项当作 false：那等于静默宣称「这不是危险命令」，与整条链路
 * fail-closed 的方向相反，而且不留痕迹。缺失只可能来自 sidecar 与主进程
 * 版本不一致，属于契约违约，应当显式失败——调用方 evaluateToolCall 的
 * catch 会把它转成 deny，用户能看到拒绝理由，不会被无声放行。
 */
function readFlags(value: unknown): ToolCallFlags {
  if (!isRecord(value)) throw new Error('invalid tool call: flags');
  const flags = {} as ToolCallFlags;
  for (const key of FLAG_KEYS) {
    if (typeof value[key] !== 'boolean') throw new Error(`invalid tool call: flags.${key}`);
    flags[key] = value[key] as boolean;
  }
  return flags;
}

function readCall(value: unknown): ToolCallFacts {
  if (!isRecord(value)) throw new Error('invalid tool call');
  if (typeof value.tool !== 'string' || value.tool === '') throw new Error('invalid tool call: tool');
  if (typeof value.workspace !== 'string' || value.workspace === '') throw new Error('invalid tool call: workspace');
  if (!ORIGINS.includes(value.origin as ToolOrigin)) throw new Error('invalid tool call: origin');
  if (!PRESETS.includes(value.preset as ApprovalPreset)) throw new Error('invalid tool call: preset');
  return {
    tool: value.tool,
    workspace: value.workspace,
    origin: value.origin as ToolOrigin,
    preset: value.preset as ApprovalPreset,
    flags: readFlags(value.flags),
    ...(optionalString(value.sessionId, 'sessionId') === undefined ? {} : { sessionId: value.sessionId as string }),
    ...(optionalString(value.threadId, 'threadId') === undefined ? {} : { threadId: value.threadId as string }),
    ...(optionalString(value.turnId, 'turnId') === undefined ? {} : { turnId: value.turnId as string }),
    ...(optionalString(value.toolCallId, 'toolCallId') === undefined ? {} : { toolCallId: value.toolCallId as string }),
    ...(optionalString(value.command, 'command') === undefined ? {} : { command: value.command as string }),
    ...(optionalString(value.path, 'path') === undefined ? {} : { path: value.path as string }),
    ...(isRecord(value.rawArgs) ? { rawArgs: value.rawArgs } : {}),
  };
}

function readRule(value: unknown): ToolRuleInput {
  if (!isRecord(value)) throw new Error('invalid permission rule');
  if (!SCOPES.includes(value.scope as RuleScope)) throw new Error('invalid permission rule: scope');
  if (!MATCHERS.includes(value.matcherKind as MatcherKind)) throw new Error('invalid permission rule: matcherKind');
  if (!EFFECTS.includes(value.effect as ToolEffect)) throw new Error('invalid permission rule: effect');
  if (typeof value.tool !== 'string' || value.tool === '') throw new Error('invalid permission rule: tool');
  return {
    scope: value.scope as RuleScope,
    scopeKey: typeof value.scopeKey === 'string' ? value.scopeKey : '',
    tool: value.tool,
    matcherKind: value.matcherKind as MatcherKind,
    matcher: typeof value.matcher === 'string' ? value.matcher : '',
    effect: value.effect as ToolEffect,
    ...(typeof value.expiresAt === 'number' ? { expiresAt: value.expiresAt } : {}),
  };
}

/**
 * 构造一组绑定到某个工作区的 RPC 处理函数。
 *
 * `owner` 来自调用方 token 所属的工作区，不是 sidecar 自报的值：调用方无法
 * 借伪造 workspace 去读写别的工作区的规则与审计。token 没有绑定工作区时全部拒绝。
 */
export function toolPermissionMethods(
  service: ToolDecisionService,
  owner: string | undefined,
): Record<string, Method> {
  const requireOwner = (): string => {
    if (!owner) throw new Error('workspace is not bound to this caller');
    return owner;
  };
  return {
    'permission.tool.evaluate': async (params) => service.evaluate({ ...readCall(params.call), workspace: requireOwner() }),
    'permission.tool.remember': async (params) => {
      const rule = readRule(params.rule);
      const scopeKey = rule.scope === 'workspace' ? requireOwner() : rule.scopeKey;
      requireOwner();
      return service.remember({ ...rule, scopeKey });
    },
    'permission.tool.settle': async (params) => {
      requireOwner();
      if (typeof params.auditId !== 'string') throw new Error('invalid auditId');
      if (!RESOLUTIONS.includes(params.resolution as AuditResolution)) throw new Error('invalid resolution');
      return { updated: service.settle(params.auditId, params.resolution as AuditResolution) };
    },
  };
}
