import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { browserWindowOptions } from "./mainConfig";
import { registerIpcHandlers } from "./ipc/register";
import { attachWebviewSecurity } from "./webviewSecurity";
import { TencentDbLayout } from "./tencentdb/layout";
import { TencentDbRuntime } from "./tencentdb/runtime";
import { TencentDbPanelRuntime } from "./tencentdb/panelRuntime";
import { TencentDbService } from "./tencentdb/service";

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
    const layout = new TencentDbLayout({
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
    });
    const memoryRuntime = new TencentDbRuntime(layout);
    const panelRuntime = new TencentDbPanelRuntime(layout);
    const tencentdb = new TencentDbService({
      layout,
      memoryRuntime,
      panelRuntime,
      dataDir: join(app.getPath('userData'), 'tencentdb-memory'),
    });
    registerIpcHandlers({ tencentdb });
    app.on('before-quit', () => {
      void panelRuntime.shutdown();
      void memoryRuntime.stop();
    });
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
}
