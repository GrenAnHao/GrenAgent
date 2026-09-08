import type { ToolEffect } from './types';

/**
 * effect 强度的单一真相源：deny 压过 ask，ask 压过 allow。
 *
 * rules（用户规则）、builtinRules（内置规则）、toolDecisionService（合并两者）
 * 三处都按这个顺序取最强。单独成文件是为了让漂移在编译期暴露：如果三处各存一份，
 * 将来新增一档 effect 漏改其中一处，索引会得到 undefined、比较恒为假，
 * 结果是静默选出错误的规则而不报任何错。
 */
export const EFFECT_RANK: Record<ToolEffect, number> = { deny: 3, ask: 2, allow: 1 };
