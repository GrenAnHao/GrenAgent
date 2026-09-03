import type { BrowserWindowConstructorOptions } from "electron";
import { join } from "node:path";

export const browserWindowOptions: BrowserWindowConstructorOptions = {
  width: 1200,
  height: 800,
  minWidth: 720,
  minHeight: 520,
  frame: false,
  backgroundColor: '#0b0d12',
  webPreferences: {
    preload: join(__dirname, "../preload/preload.js"),
    webviewTag: true,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
};
