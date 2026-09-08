import { posix } from 'node:path';

/**
 * 路径比较前统一为小写正斜杠、折叠 . 与 .. 段、剥掉尾部分隔符。
 *
 * 单独成文件的理由与 effectRank 相同，消除的是类型系统管不到的漂移：rules 的
 * scopeApplies 与 ruleStore 的 applicable 必须逐字用同一份规范化。applicable 是
 * 预筛，只要它比 scopeApplies 严一点，本该匹配的规则就在到达 matchUserRules
 * 之前被滤掉，而且滤得无声无息——两份各自演化的实现编译期毫无告警。
 *
 * 折叠 .. 是必须的：否则 d:/repo/src/../secret/k.txt 不会命中
 * d:/repo/secret 下的 deny 规则，而它实际写入的就是那个位置。
 *
 * 剥尾部分隔符同理：规范化后的调用路径永不以 / 结尾，若保留尾斜杠，
 * 用户填的 d:/repo/ 这类 matcher 与 workspace scopeKey 会静默失效。
 *
 * 大小写一律折叠，因此在 Linux 与 macOS 这类大小写敏感的文件系统上，
 * /home/u/secret 与 /home/u/SECRET 会被视作同一路径。这对 deny 规则是
 * 更严格的一侧，对 allow 规则则更宽松。
 *
 * 已知残留：穿越到盘符根之上时 .. 无法完全折叠，d:/repo/../../secret/k.txt
 * 得到相对路径 secret/k.txt，匹配不上任何绝对路径 matcher。这类调用由内置规则的
 * outsideWorkspace 标志兜住（win32.resolve('D:/repo', '../../secret/k.txt') 得
 * D:\secret\k.txt，不在工作区之下）。只影响 Windows 盘符路径：POSIX 绝对路径在根上
 * 会正确截断（/home/u/../../secret 得 /secret）。也不能无条件改用 win32.normalize，
 * 它会把 POSIX 路径 /home/u/../../secret 变成 \secret。
 *
 * 注意与 extensions/safety/rules.ts 里同名的 normalizePath 语义不同：那一份只剥
 * 前导 ./、不折叠 .. 也不改大小写（穿越由 matchWriteAllowed 直接拒绝）。两个包不能
 * 互相 import，这份重复无法避免，但两者不可互换。
 */
export function normalizeComparablePath(value: string): string {
  const normalized = posix.normalize(value.replace(/\\/g, '/')).toLowerCase();
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}
