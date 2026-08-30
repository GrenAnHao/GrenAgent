import { describe, it, expect } from 'vitest';
import { isUnder, pathsEquivalent } from './pathUtils';

describe('isUnder', () => {
  it('matches prefix dir and self', () => {
    expect(isUnder('/a/b/c', '/a/b')).toBe(true);
    expect(isUnder('/a/b', '/a/b')).toBe(true);
  });
  it('rejects sibling sharing string prefix', () => {
    expect(isUnder('/a/bc', '/a/b')).toBe(false);
  });
  it('windows: case-insensitive + separators', () => {
    expect(isUnder('C:\\U\\x\\.pi\\agent\\works\\u1', 'c:/U/x/.pi/agent/works')).toBe(true);
  });
  it('empty inputs are false', () => {
    expect(isUnder('', '/a')).toBe(false);
    expect(isUnder('/a', '')).toBe(false);
  });

  it('handles windows verbatim prefix mismatch', () => {
    expect(isUnder('C:\\U\\works\\u1', '\\\\?\\C:\\U\\works')).toBe(true);
    expect(isUnder('\\\\?\\C:\\U\\works\\u1', 'C:\\U\\works')).toBe(true);
  });
});

describe('pathsEquivalent', () => {
  it('treats separators and case as equivalent', () => {
    expect(pathsEquivalent('C:\\ws\\a', 'c:/ws/a')).toBe(true);
    expect(pathsEquivalent('/ws/a/', '/ws/a')).toBe(true);
  });

  it('treats windows verbatim prefix as equivalent', () => {
    expect(pathsEquivalent('\\\\?\\C:\\a', 'C:\\a')).toBe(true);
  });
});
