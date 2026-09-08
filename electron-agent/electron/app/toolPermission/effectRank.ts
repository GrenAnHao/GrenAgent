import type { ToolEffect } from './types';

/**
 * effect 强度的单一真相源：deny 压过 ask，ask 压过 allow。
 *
 * rules（用户规则）、builtinRules（内置规则）、toolDecisionService（合并两者）
 * 三处都按这个顺序取最强。单独成文件消除的是类型系统管不到的那类漂移：
 * Record<ToolEffect, number> 只保证各处的键齐全（漏一档会报 TS2741），不保证数值一致，
 * {deny:3,ask:2,allow:1} 与 {deny:1,ask:3,allow:2} 放在一起编译毫无告警。
 * 一旦某处的数值或顺序被改动，「冲突时取最强」的不变量会静默失真而不报错。
 */
export const EFFECT_RANK: Record<ToolEffect, number> = { deny: 3, ask: 2, allow: 1 };
