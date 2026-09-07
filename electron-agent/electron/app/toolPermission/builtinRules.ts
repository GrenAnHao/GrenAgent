import type { ApprovalPreset, ToolCallFacts, ToolEffect } from './types';

export interface BuiltinRule {
  id: string;
  effect: ToolEffect;
  match(call: ToolCallFacts): boolean;
}

/**
 * 受保护路径写入：任何档位都不许做（full 除外，见下）。
 * 危险命令：必须逐次确认，用户规则无法降级为静默放行。
 */
const GUARDS: BuiltinRule[] = [
  { id: 'builtin.protected-path', effect: 'deny', match: (c) => c.flags.write && c.flags.protectedPath },
  { id: 'builtin.dangerous-command', effect: 'ask', match: (c) => c.flags.dangerousCommand },
];

/** ask 档额外逐次确认的动作，对应现有 safety 钩子的第 ③ 层。 */
const ASK_EXTRA: BuiltinRule[] = [
  { id: 'builtin.mcp', effect: 'ask', match: (c) => c.flags.mcp },
  { id: 'builtin.network', effect: 'ask', match: (c) => c.flags.network },
  { id: 'builtin.outside-workspace-write', effect: 'ask', match: (c) => c.flags.write && c.flags.outsideWorkspace },
  { id: 'builtin.mutating-command', effect: 'ask', match: (c) => c.flags.mutatingCommand },
  { id: 'builtin.code-exec', effect: 'ask', match: (c) => c.flags.codeExec },
];

/**
 * full 档为空集是刻意的：现有 extensions/safety/index.ts 在 full 时于第 53-55 行
 * 直接返回，第 ④ 层的危险命令与受保护路径同样不执行。这里保持行为等价。
 */
export const BUILTIN_RULES: Record<ApprovalPreset, readonly BuiltinRule[]> = {
  full: [],
  auto: GUARDS,
  ask: [...GUARDS, ...ASK_EXTRA],
};

const EFFECT_RANK: Record<ToolEffect, number> = { deny: 3, ask: 2, allow: 1 };

/** 选出当前档位下命中的最强内置规则；无命中返回 undefined。 */
export function matchBuiltinRules(call: ToolCallFacts): BuiltinRule | undefined {
  // preset 由 sidecar 经 TCP 传来，版本漂移或将来新增档位都可能给到表外的值。
  // 收敛到最严的 ask 档：直接索引会抛 TypeError，兜底成空集则等同 full，是最宽松的一侧。
  // 用 hasOwn 而非 ?? ：preset 取到 toString 等原型链键时会拿到继承来的函数，非 nullish，
  // ?? 不触发而 for...of 照样抛错。与 rules.ts 里 EFFECT_RANK 的守卫同源。
  const rules = Object.hasOwn(BUILTIN_RULES, call.preset) ? BUILTIN_RULES[call.preset] : BUILTIN_RULES.ask;
  let best: BuiltinRule | undefined;
  for (const rule of rules) {
    if (!rule.match(call)) continue;
    if (!best || EFFECT_RANK[rule.effect] > EFFECT_RANK[best.effect]) best = rule;
  }
  return best;
}
