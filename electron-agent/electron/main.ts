import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { browserWindowOptions } from "./mainConfig";
import { registerIpcHandlers } from "./ipc/register";

export function createWindow() {
  const window = new BrowserWindow(browserWindowOptions);
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
