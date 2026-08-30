/**
 * Mermaid 渲染失败时的本地启发式修复：只覆盖确定性的、常见的语法坑，能本地修掉的就不必
 * 惊动 AI。修不了返回 null，交给上层降级到错误卡片 /「让 AI 修复」。
 */

/**
 * gantt：task 的 metadata 第一段若写成「数字-数字」（如版本号 87-88 / 94-95），会被 mermaid
 * 当成 startDate 解析；连字符数字不是合法日期 → "Invalid date:87-88" 整图渲染中止。
 * （两段 metadata `:X, 时长` 的第一段总被当 startDate，加字母前缀也救不了——`t87_88` 仍按
 * 日期解析失败。）这类「伪 id」既不显示也无引用价值，直接移除，让该 task 退化为「仅时长」
 * 接续排期，使整图能渲染出来。
 *
 * 仅匹配 task 行里「名称 : 」后紧跟的「两段式数字」token（如 87-88）+ 逗号。关键是用
 * `(?![-\d])` 把范围限定在恰好两段（\d+-\d+）：ISO 日期 `2026-06-16` 是三段（\d+-\d+-\d+），
 * 第二个连字符会让 lookahead 失配从而被保留——否则会把任务的合法 startDate 一并删掉，反而让
 * 整图（如「首个任务带日期 + 后续任务带伪 id」的常见场景）彻底渲染失败。也不会误伤 `:85, ...`
 * （首 token 无连字符）或无 `:` 的 dateFormat / axisFormat。
 */
function fixGanttBadTaskId(code: string): string {
  return code.replace(
    /(^[ \t]*[^\n:]*:[ \t]*)\d+-\d+(?![-\d])[ \t]*,[ \t]*/gm,
    (_m, prefix: string) => prefix,
  );
}

/**
 * flowchart/graph：subgraph 标题含特殊字符（=、()、%、: 等）且未加引号、也不是 `id[title]` 形式时，
 * mermaid lexer 报 "Unrecognized text"（如 `subgraph 第3层=结果`）。把这类裸标题整体用双引号包起来：
 * `subgraph 第3层=结果` → `subgraph "第3层=结果"`。已是引号开头、或含 `[`（id[title] 形式）的不动；
 * 不含问题字符的纯标题（纯中文/字母数字）也不动——mermaid 本就接受，避免误伤 `subgraph A` 这类 id 引用。
 */
function fixSubgraphTitle(code: string): string {
  return code.replace(/^([ \t]*subgraph[ \t]+)([^\n]+?)[ \t]*$/gm, (m, prefix: string, title: string) => {
    if (title.startsWith('"') || title.includes('[')) return m;
    if (!/[=()（）%:,;&|<>]/.test(title)) return m;
    return `${prefix}"${title}"`;
  });
}

/**
 * 尝试本地修复一段 mermaid 源码。返回修复后的新代码；没有可修的地方返回 null。
 */
export function autoFixMermaid(code: string): string | null {
  const firstWord = code.trim().split(/\s+/)[0]?.toLowerCase();
  let fixed = code;

  if (firstWord === 'gantt') {
    fixed = fixGanttBadTaskId(fixed);
  } else if (firstWord === 'flowchart' || firstWord === 'graph') {
    fixed = fixSubgraphTitle(fixed);
  }

  return fixed === code ? null : fixed;
}
