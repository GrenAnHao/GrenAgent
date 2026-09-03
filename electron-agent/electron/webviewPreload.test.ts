// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { findAnchor, isNavigable, resolveNavigableUrl } from './webviewPreload';

describe('webview link interception', () => {
  it('finds an anchor from the composed event path', () => {
    const anchor = document.createElement('a');
    anchor.href = 'https://www.msn.com/news';
    const child = document.createElement('span');
    anchor.append(child);

    expect(findAnchor(child, [child, anchor, document.body])).toBe(anchor);
  });

  it('resolves only navigable window targets', () => {
    expect(resolveNavigableUrl('/news', 'https://www.msn.com/')).toBe('https://www.msn.com/news');
    expect(resolveNavigableUrl('javascript:alert(1)', 'https://www.msn.com/')).toBeNull();
    expect(isNavigable('https://www.msn.com/news')).toBe(true);
  });
});
