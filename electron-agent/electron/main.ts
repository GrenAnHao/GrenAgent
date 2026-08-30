import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { browserWindowOptions } from "./mainConfig";
import { registerIpcHandlers } from "./ipc/register";
import { attachWebviewSecurity } from "./webviewSecurity";

export function createWindow() {
  const window = new BrowserWindow(browserWindowOptions);
  attachWebviewSecurity(window.webContents);
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;

  if (rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(join(__dirname, "../dist/index.html"));
  }
}

if (!process.env.VITEST) {
  app.whenReady().then(() => {
    registerIpcHandlers();
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
}
