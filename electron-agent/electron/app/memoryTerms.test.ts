import { describe, expect, it } from 'vitest';
import { memoryTerms, sharedCount, termOverlap } from './memoryTerms';

describe('memoryTerms', () => {
  it('中文取二元组，英文取 3 字符以上的词，去停用词，转小写', () => {
    // 「团队决定用」切出 团队（停用）、队决、决定、定用；英文词排在中文之前。
    expect(memoryTerms('团队决定用 SQLite 存储')).toEqual(['sqlite', '队决', '决定', '定用', '存储']);
  });

  it('单字和两字以下英文不算', () => {
    expect(memoryTerms('a 的 is')).toEqual([]);
  });

  it('limit 截断', () => {
    expect(memoryTerms('一二三四五六七八', 3)).toHaveLength(3);
  });
});

describe('termOverlap / sharedCount', () => {
  it('按查询词计算命中比例和命中数', () => {
    const query = memoryTerms('团队决定用 SQLite 存储');
    const target = new Set(memoryTerms('存储层决定改用 SQLite'));
    expect(sharedCount(query, target)).toBe(3);
    expect(termOverlap(query, target)).toBe(0.6);
    expect(termOverlap([], target)).toBe(0);
  });
});
