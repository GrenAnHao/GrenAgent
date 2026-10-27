import { describe, expect, it } from 'vitest';
import { resolveMarkdownLink } from './markdownLinks';

const posix = { root: '/repo', filePath: '/repo/docs/guide/a.md' };
const win = { root: 'C:\\repo', filePath: 'C:\\repo\\docs\\a.md' };

describe('resolveMarkdownLink', () => {
  it('./ 和 ../ 以当前文件所在目录为基准', () => {
    expect(resolveMarkdownLink('./b.md', posix)).toEqual({ kind: 'file', path: '/repo/docs/guide/b.md', rel: 'docs/guide/b.md' });
    expect(resolveMarkdownLink('b.md', posix)).toMatchObject({ rel: 'docs/guide/b.md' });
    expect(resolveMarkdownLink('../c.md', posix)).toMatchObject({ rel: 'docs/c.md' });
    expect(resolveMarkdownLink('../../README.md', posix)).toMatchObject({ path: '/repo/README.md', rel: 'README.md' });
    expect(resolveMarkdownLink('./x/../y/./z.md', posix)).toMatchObject({ rel: 'docs/guide/y/z.md' });
  });

  it('越过项目根的 .. 被拦下', () => {
    expect(resolveMarkdownLink('../../../etc/passwd', posix)).toMatchObject({ kind: 'unsupported' });
    expect(resolveMarkdownLink('/../x', posix)).toMatchObject({ kind: 'unsupported' });
  });

  it('含空格路径：%20 解码；query 和 hash 不进路径', () => {
    expect(resolveMarkdownLink('./my%20notes/a%20b.md?x=1#top', posix)).toMatchObject({ rel: 'docs/guide/my notes/a b.md' });
  });

  it('/ 开头：项目内绝对路径原样用，否则当相对项目根', () => {
    expect(resolveMarkdownLink('/repo/src/app.ts', posix)).toMatchObject({ rel: 'src/app.ts' });
    expect(resolveMarkdownLink('/src/app.ts', posix)).toMatchObject({ path: '/repo/src/app.ts', rel: 'src/app.ts' });
  });

  it('Windows：反斜杠、盘符、大小写不敏感，输出用根的分隔符', () => {
    expect(resolveMarkdownLink('..\\README.md', win)).toEqual({ kind: 'file', path: 'C:\\repo\\README.md', rel: 'README.md' });
    expect(resolveMarkdownLink('c:/REPO/src/a.ts', win)).toMatchObject({ path: 'C:\\repo\\src\\a.ts' });
    expect(resolveMarkdownLink('D:\\other\\a.md', win)).toMatchObject({ kind: 'unsupported' });
  });

  it('指向项目根自己时 rel 为空', () => {
    expect(resolveMarkdownLink('../', { root: '/repo', filePath: '/repo/docs/a.md' })).toEqual({ kind: 'file', path: '/repo', rel: '' });
  });

  it('锚点、网页、不支持的协议原样透传分类', () => {
    expect(resolveMarkdownLink('#sec', posix)).toEqual({ kind: 'anchor', id: 'sec' });
    expect(resolveMarkdownLink('https://example.com', posix)).toEqual({ kind: 'external', url: 'https://example.com/' });
    expect(resolveMarkdownLink('mailto:a@b.c', posix)).toMatchObject({ kind: 'unsupported' });
  });

  it('当前文件不在根下时相对链接无法落地', () => {
    expect(resolveMarkdownLink('./a.md', { root: '/repo', filePath: '/elsewhere/x.md' })).toMatchObject({ kind: 'unsupported' });
  });
});
