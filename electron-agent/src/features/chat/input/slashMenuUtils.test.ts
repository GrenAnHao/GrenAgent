import { describe, it, expect } from 'vitest';
import { insertCommandDraft, parseSlashContext, stripSlashToken } from './slashMenuUtils';

describe('parseSlashContext', () => {
  it('opens at line-start slash', () => {
    expect(parseSlashContext('/', 1)).toEqual({
      query: '',
      slashIndex: 0,
      replaceEnd: 1,
    });
  });

  it('captures query after slash', () => {
    expect(parseSlashContext('/com', 4)).toEqual({
      query: 'com',
      slashIndex: 0,
      replaceEnd: 4,
    });
  });

  it('works on second line after newline', () => {
    const text = 'hello\n/new';
    expect(parseSlashContext(text, text.length)).toEqual({
      query: 'new',
      slashIndex: 6,
      replaceEnd: 10,
    });
  });

  it('returns null when slash is not at line start', () => {
    expect(parseSlashContext('say /com', 8)).toBeNull();
  });

  it('returns null when query contains a space', () => {
    expect(parseSlashContext('/com pact', 9)).toBeNull();
  });

  it('returns null when cursor is before slash on same line', () => {
    expect(parseSlashContext('/compact', 0)).toBeNull();
  });
});

describe('stripSlashToken', () => {
  it('removes slash token at line start', () => {
    const ctx = { query: 'com', slashIndex: 0, replaceEnd: 4 };
    expect(stripSlashToken('/com rest', ctx)).toBe(' rest');
  });

  it('removes slash token on a later line', () => {
    const text = 'hello\n/new';
    const ctx = { query: 'new', slashIndex: 6, replaceEnd: 10 };
    expect(stripSlashToken(text, ctx)).toBe('hello\n');
  });
});

describe('insertCommandDraft', () => {
  it('replaces slash query with command draft and trailing space', () => {
    const ctx = { query: 'com', slashIndex: 0, replaceEnd: 4 };
    expect(insertCommandDraft('/com', ctx, 'compact')).toEqual({
      text: '/compact ',
      cursor: 9,
    });
  });
});
