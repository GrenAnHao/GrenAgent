import { describe, expect, it } from 'vitest';
import { memoryTerms, sharedCount, termOverlap } from './memoryTerms';

describe('memoryTerms', () => {
  it('中文取二元组，英文取 3 字符以上的词，去停用词，转小写', () => {
    // 「团队决定用」切出 团队（停用）、队决、决定、定用；英文词和中文二元组按文本出现顺序。
    expect(memoryTerms('团队决定用 SQLite 存储')).toEqual(['队决', '决定', '定用', 'sqlite', '存储']);
  });

  it('英文词和中文二元组交错出现时保持文本顺序，重复词只出现一次', () => {
    expect(memoryTerms('先跑 vitest 再跑 lint，最后 vitest')).toEqual(['先跑', 'vitest', '再跑', 'lint', '最后']);
  });

  it('句末标点不进词：结尾的 . _ - 被去掉，去掉后不足 3 字符的丢弃', () => {
    expect(memoryTerms('Run tests. Keep sqlite_ and foo- then tests ab.')).toEqual(['run', 'tests', 'keep', 'sqlite', 'foo', 'then']);
    // 词中间的 . - 保留（文件名、版本号）。
    expect(memoryTerms('see foo.ts and node-sqlite.')).toEqual(['see', 'foo.ts', 'node-sqlite']);
  });

  it('常见虚词当停用词丢掉，不留成召回噪声', () => {
    expect(memoryTerms('use not you all can has have always never only also using into they')).toEqual([]);
    expect(memoryTerms('不要 应该 必须 如果 因为 所以 但是 以及 通过 没有 每次 默认')).toEqual([]);
    expect(memoryTerms('you must use sqlite')).toEqual(['must', 'sqlite']);
  });

  it('单字和两字以下英文不算', () => {
    expect(memoryTerms('a 的 is')).toEqual([]);
  });

  it('limit 截断，保留靠前的词', () => {
    expect(memoryTerms('一二三四五六七八', 3)).toEqual(['一二', '二三', '三四']);
    expect(memoryTerms('alpha 的 beta 的 gamma', 2)).toEqual(['alpha', 'beta']);
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
