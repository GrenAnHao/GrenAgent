/**
 * 记忆文本的关键词：中文按二元组切，英文取 3 字符以上的词，按文本出现顺序排列。上游去重用向量召回，
 * Pi 没有 embedding，先用词重叠近似；去重召回和 L2 预筛共用。
 */
// 一次扫描同时匹配英文词和中文连续段，词序才能跟着文本走。
const TOKEN = /[a-z0-9][a-z0-9_.-]{2,}|[\u3400-\u9fff\uf900-\ufaff]+/g;
const TRAILING_PUNCT = /[._-]+$/;
const MIN_WORD_LENGTH = 3;
const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'are', 'was', 'from', 'will', 'should', 'when',
  'use', 'not', 'you', 'all', 'can', 'has', 'have', 'always', 'never', 'only', 'also', 'using', 'into', 'they',
  '用户', '团队', '进行', '使用', '一个', '这个', '需要', '可以', '我们', '已经', '以后',
  '不要', '应该', '必须', '如果', '因为', '所以', '但是', '以及', '通过', '没有', '每次', '默认',
]);

export function memoryTerms(text: string, limit = 32): string[] {
  const terms = new Set<string>();
  for (const token of text.toLowerCase().match(TOKEN) ?? []) {
    if (terms.size >= limit) break;
    if (/^[a-z0-9]/.test(token)) {
      // 句末的 . _ - 是标点，不属于词；去掉后可能不足 3 字符。
      const word = token.replace(TRAILING_PUNCT, '');
      if (word.length >= MIN_WORD_LENGTH && !STOP.has(word)) terms.add(word);
      continue;
    }
    for (let i = 0; i + 2 <= token.length && terms.size < limit; i++) {
      const pair = token.slice(i, i + 2);
      if (!STOP.has(pair)) terms.add(pair);
    }
  }
  return [...terms];
}

export function sharedCount(query: string[], target: Set<string>): number {
  let hits = 0;
  for (const term of query) if (target.has(term)) hits++;
  return hits;
}

export function termOverlap(query: string[], target: Set<string>): number {
  return query.length === 0 ? 0 : sharedCount(query, target) / query.length;
}
