const DOCUMENT_PROTOCOLS = new Set(['http:', 'https:']);

export const BROWSER_ADDRESS_PLACEHOLDER = '搜索或输入网址';

export function normalizeAddressInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'about:blank';
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function isBlankBrowserUrl(value: string): boolean {
  const trimmed = value.trim();
  return !trimmed || trimmed === 'about:blank';
}

export function isAllowedDocumentUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === 'about:blank') return true;
  try {
    return DOCUMENT_PROTOCOLS.has(new URL(trimmed).protocol);
  } catch {
    return false;
  }
}

export function isAllowedPopupUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function documentBrowserUrl(guestUrl: string, fallback: string): string {
  return isAllowedDocumentUrl(guestUrl) ? guestUrl : fallback;
}

export function visibleBrowserUrl(guestUrl: string, fallback: string): string {
  const url = documentBrowserUrl(guestUrl, fallback);
  return isBlankBrowserUrl(url) ? '' : url;
}
