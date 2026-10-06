/**
 * 记忆文本的关键词：中文按二元组切，英文取 3 字符以上的词。上游去重用向量召回，Pi 没有 embedding，
 * 先用词重叠近似；去重召回和 L2 预筛共用。
 */
const CJK_RUN = /[\u3400-\u9fff\uf900-\ufaff]+/g;
const WORD = /[a-z0-9][a-z0-9_.-]{2,}/g;
const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'are', 'was', 'from', 'will', 'should', 'when',
  '用户', '团队', '进行', '使用', '一个', '这个', '需要', '可以', '我们', '已经', '以后',
]);

export function memoryTerms(text: string, limit = 32): string[] {
  const lower = text.toLowerCase();
  const terms = new Set<string>();
  for (const word of lower.match(WORD) ?? []) if (!STOP.has(word)) terms.add(word);
  for (const run of lower.match(CJK_RUN) ?? []) {
    for (let i = 0; i + 2 <= run.length; i++) {
      const pair = run.slice(i, i + 2);
      if (!STOP.has(pair)) terms.add(pair);
    }
  }
  return [...terms].slice(0, limit);
}

export function sharedCount(query: string[], target: Set<string>): number {
  let hits = 0;
  for (const term of query) if (target.has(term)) hits++;
  return hits;
}

export function termOverlap(query: string[], target: Set<string>): number {
  return query.length === 0 ? 0 : sharedCount(query, target) / query.length;
}
