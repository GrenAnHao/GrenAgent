/**
 * 工具授权的跨进程契约。
 *
 * sidecar 侧在 extensions/_shared/desktop-control.ts 中重复声明结构相同的类型：
 * 两个包不能互相 import（见 app/wikiSyncService.ts 的注释），字段名必须逐字一致。
 */

export type ToolOrigin = 'main' | 'subagent' | 'goal';
export type ToolEffect = 'allow' | 'deny' | 'ask';
export type RuleScope = 'session' | 'workspace' | 'global';
export type MatcherKind = 'any' | 'command_prefix' | 'path_glob' | 'mcp_server';
export type ApprovalPreset = 'ask' | 'auto' | 'full';

/** sidecar 提取的调用特征。主进程不重新解析命令或路径，只消费这些布尔量。 */
export interface ToolCallFlags {
  /** isDangerousBash：rm -rf 之类 */
  dangerousCommand: boolean;
  /** isMutatingBash：会改动文件系统的命令 */
  mutatingCommand: boolean;
  /** matchProtectedPath：写入目标命中受保护路径 */
  protectedPath: boolean;
  /** 写入目标在工作区之外 */
  outsideWorkspace: boolean;
  /** NET_TOOLS 成员 */
  network: boolean;
  /** 工具名以 mcp__ 开头 */
  mcp: boolean;
  /** CODE_EXEC_TOOLS 成员：py_run / js_run / dap_* */
  codeExec: boolean;
  /** write / edit / WRITE_TOOLS 成员 */
  write: boolean;
}

export interface ToolCallFacts {
  tool: string;
  workspace: string;
  origin: ToolOrigin;
  preset: ApprovalPreset;
  flags: ToolCallFlags;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  toolCallId?: string;
  /** bash 命令原文，用于 command_prefix 匹配与审计 */
  command?: string;
  /** write / edit 的绝对目标路径，用于 path_glob 匹配与审计 */
  path?: string;
  /** 未经裁剪的原始参数，由 argsDigest 处理后才落库 */
  rawArgs?: Record<string, unknown>;
}

export interface ToolRule {
  id: string;
  scope: RuleScope;
  /** 随 scope 取值：session 存 sessionId，workspace 存工作区路径，global 固定为空串。 */
  scopeKey: string;
  tool: string;
  matcherKind: MatcherKind;
  /**
   * 随 matcherKind 取值：command_prefix 存命令前缀，path_glob 存路径 glob，
   * mcp_server 存裸服务名（不含 mcp__ 前缀与末尾分隔符），any 不使用（空串）。
   */
  matcher: string;
  effect: ToolEffect;
  createdAt: number;
  expiresAt?: number;
}

/** 新增规则时的输入，id 与 createdAt 由 store 生成。 */
export interface ToolRuleInput {
  scope: RuleScope;
  /** 同 ToolRule.scopeKey：session 存 sessionId，workspace 存工作区路径，global 固定为空串。 */
  scopeKey: string;
  tool: string;
  matcherKind: MatcherKind;
  /** 同 ToolRule.matcher：随 matcherKind 取命令前缀 / 路径 glob / 裸服务名，any 为空串。 */
  matcher: string;
  effect: ToolEffect;
  expiresAt?: number;
}

export interface ToolDecision {
  decision: ToolEffect;
  /** 命中的规则 id；内置规则形如 builtin.dangerous-command */
  ruleId?: string;
  /** 审计行 id，sidecar 在用户应答后回传它以更新 resolution */
  auditId: string;
}
