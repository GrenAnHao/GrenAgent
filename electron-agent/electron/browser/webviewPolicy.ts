const DOCUMENT_PROTOCOLS = new Set(['http:', 'https:']);

export function isAllowedWebviewUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === 'about:blank') return true;
  try {
    const protocol = new URL(trimmed).protocol;
    if (protocol === 'chrome-error:') return true;
    return DOCUMENT_PROTOCOLS.has(protocol);
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

export function applyWillAttachPolicy(
  webPreferences: {
    nodeIntegration?: boolean;
    contextIsolation?: boolean;
    sandbox?: boolean;
    preload?: string;
  },
  params: Record<string, unknown>,
  preloadPath: string,
): boolean {
  webPreferences.nodeIntegration = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.preload = preloadPath;
  delete params.preload;
  delete params.nodeintegration;
  delete params.disablewebsecurity;
  const src = typeof params.src === 'string' && params.src.trim() ? params.src : 'about:blank';
  return isAllowedWebviewUrl(src);
}
