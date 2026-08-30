import { describe, expect, it } from 'vitest';

import { sanitizeMermaidCode } from './sanitizeMermaid';

describe('sanitizeMermaidCode', () => {
  it('给含花括号的边标签加引号（日志里的真实报错场景）', () => {
    const out = sanitizeMermaidCode('flowchart TD\n  A[worker.ts] -->|import { parentPort }| B[worker]');
    expect(out).toContain('-->|"import { parentPort }"|');
  });

  it('给含圆括号的边标签加引号', () => {
    expect(sanitizeMermaidCode('graph LR\n  A -->|call fn()| B')).toContain('-->|"call fn()"|');
  });

  it('覆盖各种边箭头形态（虚线/粗线/--x）', () => {
    const out = sanitizeMermaidCode('flowchart TD\n  A -.->|a{1}| B\n  C ==>|c{2}| D\n  E --x|e{3}| F');
    expect(out).toContain('-.->|"a{1}"|');
    expect(out).toContain('==>|"c{2}"|');
    expect(out).toContain('--x|"e{3}"|');
  });

  it('无风险字符的标签保持原样', () => {
    const input = 'flowchart TD\n  A -->|yes| B';
    expect(sanitizeMermaidCode(input)).toBe(input);
  });

  it('已加引号的标签不重复加引号', () => {
    const input = 'flowchart TD\n  A -->|"import { x }"| B';
    expect(sanitizeMermaidCode(input)).toBe(input);
  });

  it('标签内已有的双引号会被转义', () => {
    expect(sanitizeMermaidCode('flowchart TD\n  A -->|say "hi" {x}| B')).toContain('|"say &quot;hi&quot; {x}"|');
  });

  it('非 flowchart 图（sequenceDiagram）不动 pipe', () => {
    const input = 'sequenceDiagram\n  Alice->>John: Hello |{x}|';
    expect(sanitizeMermaidCode(input)).toBe(input);
  });

  it('一行多个边标签都会处理', () => {
    const out = sanitizeMermaidCode('flowchart LR\n  A -->|a{1}| B -->|b(2)| C');
    expect(out).toContain('-->|"a{1}"|');
    expect(out).toContain('-->|"b(2)"|');
  });

  it('节点文本里的单个 `|` 不被误伤', () => {
    const out = sanitizeMermaidCode('flowchart TD\n  A["a or b"] -->|ok| B');
    expect(out).toContain('A["a or b"]');
    expect(out).toContain('-->|ok|');
  });

  it('节点 [] 标签内的裸引号被包裹并转义（报错复现场景）', () => {
    const out = sanitizeMermaidCode('flowchart LR\n  OVERVIEW[但不提供"一键安装""评论"等功能]');
    expect(out).toContain('OVERVIEW["但不提供&quot;一键安装&quot;&quot;评论&quot;等功能"]');
  });

  it('节点 () 与 {} 标签内裸引号同样处理', () => {
    expect(sanitizeMermaidCode('flowchart TD\n  A(说"你好")')).toContain('A("说&quot;你好&quot;")');
    expect(sanitizeMermaidCode('graph LR\n  B{选"是"或"否"}')).toContain('B{"选&quot;是&quot;或&quot;否&quot;"}');
  });

  it('已是干净带引号的节点标签不重复处理', () => {
    const input = 'flowchart TD\n  A["已经正确的标签"]';
    expect(sanitizeMermaidCode(input)).toBe(input);
  });

  it('无引号的节点标签保持原样', () => {
    const input = 'flowchart TD\n  A[普通文本] --> B(圆形节点)';
    expect(sanitizeMermaidCode(input)).toBe(input);
  });

  it('内容含括号的节点标签（复合形状/已转义）不被误伤', () => {
    const input = 'flowchart TD\n  A["parse.ts (修改)<br/>fn()"]';
    expect(sanitizeMermaidCode(input)).toBe(input);
  });

  it('真实 subgraph 图（节点已加引号、无裸边标签）不被误伤', () => {
    const input = [
      'flowchart TD',
      '    subgraph "Node 当前实现"',
      "        A[\"parse-worker.ts<br/>worker_threads API<br/>parentPort.on('message')\"]",
      '    end',
      '    subgraph "Bun 兼容性路径"',
      "        C[\"parse-worker.ts (修改)<br/>import { Worker } from 'worker_threads'<br/>Bun 有 partial polyfill\"]",
      '    end',
      '    style A fill:#e1f5fe',
      '    style C fill:#fff3e0',
    ].join('\n');
    expect(sanitizeMermaidCode(input)).toBe(input);
  });
});
