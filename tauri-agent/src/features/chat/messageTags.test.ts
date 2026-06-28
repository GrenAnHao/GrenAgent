import { describe, expect, it } from 'vitest';
import { parseMessageTags } from './messageTags';

describe('parseMessageTags', () => {
  it('splits a file mention from surrounding text', () => {
    const segs = parseMessageTags('看一下 @src/foo.ts 这个文件');
    expect(segs).toEqual([
      { type: 'text', text: '看一下 ' },
      { type: 'file', path: 'src/foo.ts' },
      { type: 'text', text: ' 这个文件' },
    ]);
  });

  it('handles a mention at the very start', () => {
    const segs = parseMessageTags('@README.md is the entry');
    expect(segs[0]).toEqual({ type: 'file', path: 'README.md' });
    expect(segs[1]).toEqual({ type: 'text', text: ' is the entry' });
  });

  it('keeps multiple mentions', () => {
    const segs = parseMessageTags('@a.ts and @b/c.ts');
    expect(segs.filter((s) => s.type === 'file')).toEqual([
      { type: 'file', path: 'a.ts' },
      { type: 'file', path: 'b/c.ts' },
    ]);
  });

  it('does not treat an email address as a mention', () => {
    const segs = parseMessageTags('mail me at user@host.com please');
    expect(segs.every((s) => s.type === 'text')).toBe(true);
  });

  it('returns a single text segment when there is no mention', () => {
    expect(parseMessageTags('plain text')).toEqual([{ type: 'text', text: 'plain text' }]);
  });

  it('collapses an expanded <skill> block to a skill segment', () => {
    const text =
      '<skill name="caveman" location="C:\\Users\\me\\.agents\\skills\\caveman\\SKILL.md">\nUltra-compressed.\n\n## Rules\nbe brief.\n</skill>';
    expect(parseMessageTags(text)).toEqual([{ type: 'skill', name: 'caveman' }]);
  });

  it('renders an optimistic /skill:name command as a skill segment', () => {
    expect(parseMessageTags('/skill:caveman')).toEqual([{ type: 'skill', name: 'caveman' }]);
  });

  it('strips a skill: prefix from the expanded block name', () => {
    const text = '<skill name="skill:caveman" location="x">body</skill>';
    expect(parseMessageTags(text)).toEqual([{ type: 'skill', name: 'caveman' }]);
  });

  it('keeps trailing args after a skill block as text', () => {
    const segs = parseMessageTags('<skill name="review" location="x">body</skill> 然后帮我改');
    expect(segs[0]).toEqual({ type: 'skill', name: 'review' });
    expect(segs[1]).toEqual({ type: 'text', text: ' 然后帮我改' });
  });

  it('把行内 URL 切成 link 段', () => {
    const segs = parseMessageTags('看 https://vercel.com/docs 这个');
    expect(segs).toEqual([
      { type: 'text', text: '看 ' },
      { type: 'link', url: 'https://vercel.com/docs' },
      { type: 'text', text: ' 这个' },
    ]);
  });

  it('URL 在开头', () => {
    const segs = parseMessageTags('https://a.com is up');
    expect(segs[0]).toEqual({ type: 'link', url: 'https://a.com' });
  });

  it('不误伤 email 与普通路径', () => {
    expect(parseMessageTags('user@host.com').every((s) => s.type === 'text')).toBe(true);
    expect(parseMessageTags('see /src/foo.ts')[0].type).toBe('text');
  });
});
