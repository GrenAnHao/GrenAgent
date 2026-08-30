import { describe, expect, it } from 'vitest';
import { splitDataImages, stripDataImages, stripInlineImages } from './splitDataImages';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('splitDataImages', () => {
  it('无 data 图时返回单个 markdown 段', () => {
    const md = '# Hello\n\nsome text';
    expect(splitDataImages(md)).toEqual([{ content: md, type: 'markdown' }]);
  });

  it('把 data-URL 图片切成独立 image 段', () => {
    const result = splitDataImages(`前文\n\n![image_1](${PNG})\n\n后文`);
    expect(result.map((s) => s.type)).toEqual(['markdown', 'image', 'markdown']);
    const img = result[1];
    expect(img).toEqual({ type: 'image', alt: 'image_1', src: PNG });
  });

  it('剥掉紧贴图片前的图片请求 JSON 回显', () => {
    const md = `{"prompt":"a cat","size":"1024x1024","n":1,"transparent_background":false}![image_1](${PNG})`;
    const result = splitDataImages(md);
    // JSON 被剥掉 → 只剩一个 image 段
    expect(result).toEqual([{ type: 'image', alt: 'image_1', src: PNG }]);
  });

  it('不误删正文里与图片无关的 JSON', () => {
    const md = '```json\n{"prompt":"keep me"}\n```\n\n没有图片';
    expect(splitDataImages(md)).toEqual([{ content: md, type: 'markdown' }]);
  });

  it('空字符串返回单个 markdown 段', () => {
    expect(splitDataImages('')).toEqual([{ content: '', type: 'markdown' }]);
  });
});

describe('stripDataImages', () => {
  it('无图片时原样返回', () => {
    expect(stripDataImages('# Hi\n\n正文')).toBe('# Hi\n\n正文');
  });

  it('剥掉 data-URL 图片，保留正文', () => {
    expect(stripDataImages(`前文\n\n![a](${PNG})\n\n后文`)).toBe('前文\n\n\n\n后文');
  });

  it('连同图片请求 JSON 回显一起剥掉', () => {
    expect(stripDataImages(`{"prompt":"a cat","size":"1024x1024"}![a](${PNG})`)).toBe('');
  });
});

describe('stripInlineImages', () => {
  it('剥本地/相对路径的图片引用（避免裂图 + 与工具卡重复）', () => {
    expect(stripInlineImages('全身照来了\n\n![全身照](/proj/.pi/images/x.png)')).toBe('全身照来了\n\n');
    expect(stripInlineImages('![](images/a.png)')).toBe('');
  });

  it('保留 http(s) 图片引用', () => {
    const md = '看图 ![cat](https://example.com/a.png)';
    expect(stripInlineImages(md)).toBe(md);
  });

  it('data-URL 图片仍被剥', () => {
    expect(stripInlineImages(`![a](${PNG})`)).toBe('');
  });

  it('无图片引用时原样返回', () => {
    expect(stripInlineImages('# 标题\n\n正文')).toBe('# 标题\n\n正文');
  });
});
