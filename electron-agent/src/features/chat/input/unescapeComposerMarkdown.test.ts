import { describe, expect, it } from 'vitest';
import { unescapeComposerMarkdown } from './unescapeComposerMarkdown';

describe('unescapeComposerMarkdown', () => {
  it('unwraps gfm email autolinks', () => {
    expect(unescapeComposerMarkdown('hello <user@gmail.com>\n')).toBe('hello user@gmail.com\n');
  });

  it('unescapes backslash before at-sign', () => {
    expect(unescapeComposerMarkdown('hello user\\@gmail.com')).toBe('hello user@gmail.com');
  });

  it('unescapes markdown underscores', () => {
    expect(unescapeComposerMarkdown('foo\\_bar\\_baz')).toBe('foo_bar_baz');
  });

  it('keeps file mentions and url autolinks', () => {
    expect(unescapeComposerMarkdown('see @src/index.ts and <https://a.com>')).toBe(
      'see @src/index.ts and <https://a.com>',
    );
  });

  it('does not unwrap urls that happen to contain @', () => {
    expect(unescapeComposerMarkdown('<https://user@host/path>')).toBe('<https://user@host/path>');
  });
});
