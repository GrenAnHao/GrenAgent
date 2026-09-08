import { EFFECT_RANK } from './effectRank';
import { normalizeComparablePath } from './paths';
import type { RuleScope, ToolCallFacts, ToolRule } from './types';

const SCOPE_RANK: Record<RuleScope, number> = { session: 3, workspace: 2, global: 1 };

/**
 * 转义单个路径段内的正则元字符，并把 * 展开为「段内任意字符」。
 *
 * 连续星号整体替换成一个 [^/]*：段内 N 个星号与 1 个语义等价
 * （[^/]* 相接可任意切分），但逐个展开会让正则引擎穷举切分方式，
 * 不匹配的长输入上耗时随星号个数指数增长。
 */
function escapeSegment(segment: string): string {
  return segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*+/g, '[^/]*');
}

/**
 * 把 glob 转成正则。只支持两种通配符，其余字符一律转义，
 * 因此用户规则里的 . ( ) 等不会被当作正则元字符：
 *
 * - `*`  匹配单个路径段内的任意字符，不跨目录
 * - `**` 作为独立路径段时匹配零个或多个完整目录段，位于末尾时吃掉剩余全部；
 *        所以以 `**` 加 `.env` 结尾的规则同时命中 d:/repo/.env 与 d:/repo/a/.env
 */
function globToRegExp(glob: string): RegExp {
  const segments = glob.split('/');
  let source = '';
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const last = i === segments.length - 1;
    if (segment === '**') {
      // 相邻的 ** 段等价于一个，跳过重复项：多个 (?:[^/]+/)* 相接同样会引发穷举切分。
      if (segments[i + 1] === '**') continue;
      source += last ? '.*' : '(?:[^/]+/)*';
      continue;
    }
    source += escapeSegment(segment);
    if (!last) source += '/';
  }
  return new RegExp(`^${source}$`);
}

function toolMatches(pattern: string, tool: string): boolean {
  if (pattern.endsWith('*')) return tool.startsWith(pattern.slice(0, -1));
  return pattern === tool;
}

function scopeApplies(rule: ToolRule, call: ToolCallFacts): boolean {
  if (rule.scope === 'global') return true;
  if (rule.scope === 'session') return rule.scopeKey !== '' && rule.scopeKey === call.sessionId;
  if (rule.scope === 'workspace') {
    return rule.scopeKey !== '' && normalizeComparablePath(rule.scopeKey) === normalizeComparablePath(call.workspace);
  }
  // 库里的未知 scope（版本回退、手改数据）不匹配任何调用，而不是落进某个具体分支被误判。
  return false;
}

function matcherApplies(rule: ToolRule, call: ToolCallFacts): boolean {
  if (rule.matcherKind === 'any') return true;
  if (rule.matcherKind === 'command_prefix') {
    return call.command !== undefined && call.command.trimStart().startsWith(rule.matcher);
  }
  if (rule.matcherKind === 'path_glob') {
    if (call.path === undefined) return false;
    return globToRegExp(normalizeComparablePath(rule.matcher)).test(normalizeComparablePath(call.path));
  }
  if (rule.matcherKind === 'mcp_server') return call.tool.startsWith(`mcp__${rule.matcher}__`);
  // 同上：未知 matcherKind 一律不匹配。
  return false;
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
    // hasOwn 而非 in：'toString' 之类原型链上的键会让 in 放行，随后算出 NaN 被顺带拦下。
    if (!Object.hasOwn(EFFECT_RANK, rule.effect)) continue;
    if (!toolMatches(rule.tool, call.tool)) continue;
    if (!scopeApplies(rule, call)) continue;
    if (!matcherApplies(rule, call)) continue;
    // 位权编码：effect 占十位、scope 占个位，因此强度永远压过作用域宽窄。
    const rank = EFFECT_RANK[rule.effect] * 10 + SCOPE_RANK[rule.scope];
    if (rank > bestRank) {
      best = rule;
      bestRank = rank;
    }
  }
  return best;
}
