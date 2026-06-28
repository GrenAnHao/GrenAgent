import { describe, expect, it } from 'vitest';

import { formatUrlLabel, isSingleUrl, resolveUrlTag } from './urlPaste';

describe('isSingleUrl', () => {
  it('接受单条 http(s) URL（含首尾空白）', () => {
    expect(isSingleUrl('https://github.com/lobehub/lobe-chat')).toBe(true);
    expect(isSingleUrl('  http://example.com  ')).toBe(true);
  });
  it('拒绝含空白 / 非 URL / 路径', () => {
    expect(isSingleUrl('看 https://a.com')).toBe(false);
    expect(isSingleUrl('https://a.com https://b.com')).toBe(false);
    expect(isSingleUrl('/usr/local/bin')).toBe(false);
    expect(isSingleUrl('hello')).toBe(false);
  });
});

describe('formatUrlLabel', () => {
  it('根路径只显示 host（去 www）', () => {
    expect(formatUrlLabel('https://vercel.com')).toBe('vercel.com');
    expect(formatUrlLabel('https://www.vercel.com/')).toBe('vercel.com');
  });
  it('单段路径显示 host/段', () => {
    expect(formatUrlLabel('https://vercel.com/docs')).toBe('vercel.com/docs');
  });
  it('深路径折叠为 host/.../末段', () => {
    expect(formatUrlLabel('https://github.com/lobehub/lobe-chat/pull/123')).toBe('github.com/.../123');
  });
  it('非法 URL 原样返回', () => {
    expect(formatUrlLabel('not a url')).toBe('not a url');
  });
});

describe('resolveUrlTag', () => {
  it('单条 URL 返回 link 标签', () => {
    expect(resolveUrlTag('https://vercel.com/docs')).toEqual({
      category: 'link',
      label: 'vercel.com/docs',
      value: 'https://vercel.com/docs',
    });
  });
  it('非 URL 返回 null', () => {
    expect(resolveUrlTag('hello world')).toBeNull();
  });
});
