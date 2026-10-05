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

  it('不含空格的技能命令保持 /skill:name', () => {
    expect(tagToText('command', 'skill:caveman')).toBe('/skill:caveman');
  });

  it('技能名含空格时用引号包住，避免发送时从空格处拆开', () => {
    expect(tagToText('command', 'skill:IDA Pro逆向分析')).toBe('/skill:"IDA Pro逆向分析"');
  });

  it('链接写成原始 URL（无前缀）', () => {
    expect(tagToText('link', 'https://vercel.com/docs')).toBe('https://vercel.com/docs');
  });
});
