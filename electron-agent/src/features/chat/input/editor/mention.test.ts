import { describe, it, expect } from 'vitest';
import { fileMentionMeta, mentionMarkdownWriter } from './mention';

// markdownWriter 只读取 node.metadata / node.label，用最小桩对象即可。
const fakeNode = (label: string, metadata: Record<string, unknown>) => ({ label, metadata });

describe('mention 序列化', () => {
  it('文件提及写成 @相对路径', () => {
    const node = fakeNode('index.ts', fileMentionMeta('src/index.ts', 'index.ts', false));
    expect(mentionMarkdownWriter(node)).toBe('@src/index.ts');
  });

  it('目录提及同样用路径', () => {
    const node = fakeNode('src', fileMentionMeta('src', 'src', true));
    expect(mentionMarkdownWriter(node)).toBe('@src');
  });

  it('无 metadata 时回退到 label', () => {
    expect(mentionMarkdownWriter(fakeNode('foo', {}))).toBe('@foo');
  });
});
