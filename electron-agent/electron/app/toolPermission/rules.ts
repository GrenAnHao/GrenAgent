import type { ToolCallFacts, ToolEffect, ToolRule } from './types';

const EFFECT_RANK: Record<ToolEffect, number> = { deny: 3, ask: 2, allow: 1 };
const SCOPE_RANK = { session: 3, workspace: 2, global: 1 } as const;

/** 路径比较统一为小写正斜杠，Windows 上 D:\repo 与 d:/repo 视作同一路径。 */
function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

/** 把 glob 转成正则：** 跨目录，* 不跨目录，其余字符转义。 */
function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    if (glob[i] === '*' && glob[i + 1] === '*') {
      source += '.*';
      i += 1;
      continue;
    }
    if (glob[i] === '*') {
      source += '[^/]*';
      continue;
    }
    source += glob[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function toolMatches(pattern: string, tool: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return tool.startsWith(pattern.slice(0, -1));
  return pattern === tool;
}

function scopeApplies(rule: ToolRule, call: ToolCallFacts): boolean {
  if (rule.scope === 'global') return true;
  if (rule.scope === 'session') return rule.scopeKey !== '' && rule.scopeKey === call.sessionId;
  return rule.scopeKey !== '' && normalizePath(rule.scopeKey) === normalizePath(call.workspace);
}

function matcherApplies(rule: ToolRule, call: ToolCallFacts): boolean {
  if (rule.matcherKind === 'any') return true;
  if (rule.matcherKind === 'command_prefix') {
    return call.command !== undefined && call.command.trimStart().startsWith(rule.matcher);
  }
  if (rule.matcherKind === 'path_glob') {
    if (call.path === undefined) return false;
    return globToRegExp(normalizePath(rule.matcher)).test(normalizePath(call.path));
  }
  return call.tool.startsWith(`mcp__${rule.matcher}__`);
}

/**
 * 在用户规则中选出优先级最高的一条。
 *
 * 优先级：effect 强度（deny > ask > allow）优先于 scope 宽窄（session > workspace > global）。
 * 无匹配返回 undefined，由调用方决定兜底——本函数不假设默认值。
 */
export function matchUserRules(
  rules: readonly ToolRule[],
  call: ToolCallFacts,
  now: number,
): ToolRule | undefined {
  let best: ToolRule | undefined;
  let bestRank = -1;
  for (const rule of rules) {
    if (rule.expiresAt !== undefined && rule.expiresAt <= now) continue;
    if (!toolMatches(rule.tool, call.tool)) continue;
    if (!scopeApplies(rule, call)) continue;
    if (!matcherApplies(rule, call)) continue;
    const rank = EFFECT_RANK[rule.effect] * 10 + SCOPE_RANK[rule.scope];
    if (rank > bestRank) {
      best = rule;
      bestRank = rank;
    }
  }
  return best;
}
