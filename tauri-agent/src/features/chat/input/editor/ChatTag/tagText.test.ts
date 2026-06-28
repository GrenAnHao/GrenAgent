import { describe, it, expect } from 'vitest';
import { tagToText } from './tagText';

describe('tagToText', () => {
  it('文件写成 @路径', () => {
    expect(tagToText('file', 'src/index.ts')).toBe('@src/index.ts');
  });

  it('目录写成 @路径', () => {
    expect(tagToText('directory', 'src')).toBe('@src');
  });

  it('命令写成 /名称', () => {
    expect(tagToText('command', 'compact')).toBe('/compact');
  });

  it('链接写成原始 URL（无前缀）', () => {
    expect(tagToText('link', 'https://vercel.com/docs')).toBe('https://vercel.com/docs');
  });
});
