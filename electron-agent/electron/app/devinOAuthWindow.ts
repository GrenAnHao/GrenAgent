import { BrowserWindow } from 'electron';

const AUTHORIZE_HOST = 'app.devin.ai';
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

export interface DevinOAuthWindow {
  close(): void;
  onClosed(cb: () => void): void;
}

/** In-app window for the Devin authorize page. The loopback callback still lands on 127.0.0.1. */
export function openDevinOAuthWindow(url: string): DevinOAuthWindow {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== AUTHORIZE_HOST) {
    throw new Error('Unexpected Devin OAuth URL.');
  }
  const win = new BrowserWindow({
    width: 520,
    height: 760,
    title: 'Devin OAuth',
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setUserAgent(CHROME_UA);
  void win.loadURL(url);
  return {
    close() {
      if (!win.isDestroyed()) win.close();
    },
    onClosed(cb) {
      win.on('closed', cb);
    },
  };
}
