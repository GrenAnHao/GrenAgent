import { describe, expect, it } from 'vitest';

import { splitMermaid } from './splitMermaid';

describe('splitMermaid', () => {
  it('无 mermaid 时返回单个 markdown 段', () => {
    expect(splitMermaid('# Hello\n\nsome text')).toEqual([
      { content: '# Hello\n\nsome text', type: 'markdown' },
    ]);
  });

  it('切出单个 mermaid 块，前后正文保留', () => {
    const md = 'before\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\nafter';
    const result = splitMermaid(md);
    expect(result.map((s) => s.type)).toEqual(['markdown', 'mermaid', 'markdown']);
    expect(result.find((s) => s.type === 'mermaid')?.content).toBe('flowchart TD\n  A --> B');
  });

  it('开头就是 mermaid 块', () => {
    const result = splitMermaid('```mermaid\nflowchart TD\n  A --> B\n```\ntail');
    expect(result[0].type).toBe('mermaid');
    expect(result[1]).toEqual({ content: '\ntail', type: 'markdown' });
  });

  it('处理多个 mermaid 块', () => {
    const md = '```mermaid\ngraph LR\n  A-->B\n```\nmid\n```mermaid\ngraph TD\n  C-->D\n```';
    const result = splitMermaid(md);
    expect(result.filter((s) => s.type === 'mermaid')).toHaveLength(2);
    expect(result.some((s) => s.type === 'markdown' && s.content.includes('mid'))).toBe(true);
  });

  it('未闭合的 mermaid 块（流式中）当作 markdown，不提前切', () => {
    const md = 'x\n```mermaid\nflowchart TD\n  A --> B';
    expect(splitMermaid(md)).toEqual([{ content: md, type: 'markdown' }]);
  });

  it('提取的 mermaid code 不含围栏', () => {
    const result = splitMermaid('```mermaid\nsequenceDiagram\n  A->>B: hi\n```');
    expect(result[0]).toEqual({ content: 'sequenceDiagram\n  A->>B: hi', type: 'mermaid' });
  });

  it('空字符串返回单个 markdown 段', () => {
    expect(splitMermaid('')).toEqual([{ content: '', type: 'markdown' }]);
  });
});
