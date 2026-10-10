import { describe, expect, it, vi } from 'vitest';

const loadURL = vi.fn(async () => {});
const setUserAgent = vi.fn();
const close = vi.fn();
const on = vi.fn();
const isDestroyed = vi.fn(() => false);

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(function BrowserWindow(this: Record<string, unknown>) {
    this.webContents = { setUserAgent };
    this.loadURL = loadURL;
    this.close = close;
    this.on = on;
    this.isDestroyed = isDestroyed;
    return this;
  }),
}));

import { openDevinOAuthWindow } from './devinOAuthWindow';

describe('openDevinOAuthWindow', () => {
  it('loads only the Devin authorize page', () => {
    const win = openDevinOAuthWindow('https://app.devin.ai/auth/cli/continue?state=1');
    expect(loadURL).toHaveBeenCalledWith('https://app.devin.ai/auth/cli/continue?state=1');
    expect(setUserAgent).toHaveBeenCalled();
    win.close();
    expect(close).toHaveBeenCalled();
    expect(() => openDevinOAuthWindow('https://evil.example/auth')).toThrow(/Unexpected Devin OAuth URL/);
  });
});
