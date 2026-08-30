import { describe, expect, it } from 'vitest';
import { isAllowedWebviewUrl } from './webviewSecurity';

describe('webview navigation policy', () => {
  it('allows normal browser documents and about:blank', () => {
    expect(isAllowedWebviewUrl('https://example.com')).toBe(true);
    expect(isAllowedWebviewUrl('http://127.0.0.1:3000')).toBe(true);
    expect(isAllowedWebviewUrl('about:blank')).toBe(true);
  });

  it('rejects executable and malformed schemes', () => {
    expect(isAllowedWebviewUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedWebviewUrl('file:///C:/secret.txt')).toBe(false);
    expect(isAllowedWebviewUrl('not a url')).toBe(false);
  });
});
