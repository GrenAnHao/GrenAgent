import { describe, expect, it } from 'vitest';
import { autoFixMermaid } from './mermaidAutofix';

describe('autoFixMermaid', () => {
  it('gantt：移除会被当日期的连字符数字伪 id（87-88 → 仅保留时长）', () => {
    const code = [
      'gantt',
      '    title demo',
      '    dateFormat YYYY-MM-DD',
      '    section S',
      '    品牌icon :87-88, 1d',
    ].join('\n');
    const fixed = autoFixMermaid(code) ?? '';
    expect(fixed).not.toContain('87-88');
    expect(fixed).toContain('品牌icon :1d');
  });

  it('gantt：移除多个连字符伪 id', () => {
    const code = [
      'gantt',
      '    section S',
      '    a :94-95, 1d',
      '    b :96-98, 1d',
    ].join('\n');
    const fixed = autoFixMermaid(code) ?? '';
    expect(fixed).not.toContain('94-95');
    expect(fixed).not.toContain('96-98');
    expect(fixed).toContain('a :1d');
    expect(fixed).toContain('b :1d');
  });

  it('保留合法 ISO 日期 startDate，仅删除同图里的两段式伪 id', () => {
    const code = [
      'gantt',
      '    dateFormat YYYY-MM-DD',
      '    section S',
      '    a :2026-06-16, 1d',
      '    b :87-88, 1d',
    ].join('\n');
    const fixed = autoFixMermaid(code) ?? '';
    // 合法日期必须原样保留（旧实现会把它当伪 id 一并删掉，导致整图渲染失败）
    expect(fixed).toContain('a :2026-06-16, 1d');
    // 伪 id 被移除
    expect(fixed).not.toContain('87-88');
    expect(fixed).toContain('b :1d');
  });

  it('不误伤 dateFormat / axisFormat 里的连字符', () => {
    const code = [
      'gantt',
      '    dateFormat YYYY-MM-DD',
      '    axisFormat %m-%d',
      '    section S',
      '    a :85, 2026-06-16, 1d',
    ].join('\n');
    // 该图本身没有「连字符数字 id」需要修，返回 null
    expect(autoFixMermaid(code)).toBeNull();
  });

  it('flowchart：subgraph 标题含特殊字符（=）自动加引号', () => {
    const code = ['flowchart TD', '    subgraph 第3层=结果', '        R0 --> B', '    end'].join('\n');
    const fixed = autoFixMermaid(code) ?? '';
    expect(fixed).toContain('subgraph "第3层=结果"');
  });

  it('graph：subgraph 标题含括号自动加引号', () => {
    const code = ['graph TD', '    subgraph 阶段(一)', '        A --> B', '    end'].join('\n');
    const fixed = autoFixMermaid(code) ?? '';
    expect(fixed).toContain('subgraph "阶段(一)"');
  });

  it('不误伤纯文字 subgraph 标题与 id[title] 形式', () => {
    const code = [
      'flowchart TD',
      '    subgraph 第1层插值',
      '    end',
      '    subgraph s2[已有方括号]',
      '    end',
    ].join('\n');
    expect(autoFixMermaid(code)).toBeNull();
  });

  it('flowchart/graph 无 subgraph 问题返回 null', () => {
    expect(autoFixMermaid('graph LR\n  A-->B')).toBeNull();
  });

  it('正常 gantt（task id 合法）返回 null', () => {
    const code = ['gantt', '    section S', '    a :done, t1, 1d'].join('\n');
    expect(autoFixMermaid(code)).toBeNull();
  });
});
