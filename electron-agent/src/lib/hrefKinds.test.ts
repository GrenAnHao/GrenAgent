import { describe, expect, it } from 'vitest';
import { classifyHref } from './hrefKinds';

describe('classifyHref', () => {
  it('锚点：解码，空锚点指向顶部', () => {
    expect(classifyHref('#intro')).toEqual({ kind: 'anchor', id: 'intro' });
    expect(classifyHref('#%E4%B8%AD%E6%96%87')).toEqual({ kind: 'anchor', id: '中文' });
    expect(classifyHref('#')).toEqual({ kind: 'anchor', id: '' });
  });

  it('网页：http / https / 协议相对', () => {
    expect(classifyHref('https://example.com/a?b=1#c')).toEqual({ kind: 'external', url: 'https://example.com/a?b=1#c' });
    expect(classifyHref(' http://example.com ')).toEqual({ kind: 'external', url: 'http://example.com/' });
    expect(classifyHref('//example.com/x')).toEqual({ kind: 'external', url: 'https://example.com/x' });
  });

  it('不支持的协议都给出原因，不当成路径', () => {
    for (const href of ['mailto:a@b.c', 'javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'vscode://x']) {
      expect(classifyHref(href).kind, href).toBe('unsupported');
    }
    expect(classifyHref('')).toMatchObject({ kind: 'unsupported' });
    expect(classifyHref('http://')).toMatchObject({ kind: 'unsupported' });
  });

  it('相对路径：解码 %20、丢掉 query、保留 hash', () => {
    expect(classifyHref('./docs/my%20file.md?plain=1#sec')).toEqual({
      kind: 'path',
      path: './docs/my file.md',
      hash: 'sec',
      rooted: false,
    });
    expect(classifyHref('../a.md')).toMatchObject({ kind: 'path', path: '../a.md', rooted: false });
  });

  it('反斜杠统一成正斜杠；盘符和 / 开头算 rooted', () => {
    expect(classifyHref('docs\\a.md')).toMatchObject({ path: 'docs/a.md', rooted: false });
    expect(classifyHref('C:\\repo\\a.md')).toMatchObject({ kind: 'path', path: 'C:/repo/a.md', rooted: true });
    expect(classifyHref('/docs/a.md')).toMatchObject({ kind: 'path', rooted: true });
  });

  it('坏的百分号编码不抛错，原样保留', () => {
    expect(classifyHref('./100%.md')).toMatchObject({ kind: 'path', path: './100%.md' });
  });
});
