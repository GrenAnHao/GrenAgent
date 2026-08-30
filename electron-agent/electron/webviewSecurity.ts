import type { WebContents } from 'electron';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'about:']);

export function isAllowedWebviewUrl(value: string): boolean {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** Apply the minimum isolation policy to every guest created by the renderer. */
export function attachWebviewSecurity(embedder: WebContents): void {
  embedder.on('will-attach-webview', (event, webPreferences, params) => {
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    delete webPreferences.preload;
    if (!isAllowedWebviewUrl(params.src)) event.preventDefault();
  });

  embedder.on('did-attach-webview', (_event, guest) => {
    guest.on('will-navigate', (event, url) => {
      if (!isAllowedWebviewUrl(url)) event.preventDefault();
    });
    guest.setWindowOpenHandler(({ url }) => {
      if (isAllowedWebviewUrl(url)) void guest.loadURL(url);
      return { action: 'deny' };
    });
  });
}
