import { describe, expect, it } from 'vitest';
import {
  documentBrowserUrl,
  isAllowedDocumentUrl,
  isAllowedPopupUrl,
  isBlankBrowserUrl,
  normalizeAddressInput,
  visibleBrowserUrl,
} from './browserUrls';

describe('normalizeAddressInput', () => {
  it('adds https for a bare host and keeps explicit schemes', () => {
    expect(normalizeAddressInput('example.org')).toBe('https://example.org');
    expect(normalizeAddressInput('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(normalizeAddressInput('  ')).toBe('about:blank');
  });
});

describe('isAllowedDocumentUrl', () => {
  it('allows http(s) and exact about:blank', () => {
    expect(isAllowedDocumentUrl('https://example.com')).toBe(true);
    expect(isAllowedDocumentUrl('http://127.0.0.1:3000')).toBe(true);
    expect(isAllowedDocumentUrl('about:blank')).toBe(true);
    expect(isAllowedDocumentUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedDocumentUrl('about:srcdoc')).toBe(false);
    expect(isAllowedDocumentUrl('chrome-error://chromewebdata/')).toBe(false);
  });
});

describe('isBlankBrowserUrl', () => {
  it('treats empty and about:blank as the new-tab document', () => {
    expect(isBlankBrowserUrl('')).toBe(true);
    expect(isBlankBrowserUrl('  ')).toBe(true);
    expect(isBlankBrowserUrl('about:blank')).toBe(true);
    expect(isBlankBrowserUrl('https://example.com')).toBe(false);
  });
});

describe('visibleBrowserUrl', () => {
  it('keeps chrome-error and about:blank out of the address bar', () => {
    expect(visibleBrowserUrl('https://example.com/', 'https://fallback.test/')).toBe('https://example.com/');
    expect(visibleBrowserUrl('chrome-error://chromewebdata/', 'http://127.0.0.1:5191/')).toBe('http://127.0.0.1:5191/');
    expect(visibleBrowserUrl('about:blank', 'https://fallback.test/')).toBe('');
    expect(visibleBrowserUrl('about:blank', 'about:blank')).toBe('');
    expect(documentBrowserUrl('about:blank', 'https://fallback.test/')).toBe('about:blank');
  });
});

describe('isAllowedPopupUrl', () => {
  it('allows only http(s)', () => {
    expect(isAllowedPopupUrl('https://a.test')).toBe(true);
    expect(isAllowedPopupUrl('about:blank')).toBe(false);
    expect(isAllowedPopupUrl('javascript:alert(1)')).toBe(false);
  });
});
