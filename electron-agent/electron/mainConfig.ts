import type { BrowserWindowConstructorOptions } from "electron";
import { join } from "node:path";

/** 打包后 main 在 `out/main`，页面在 asar 根的 `dist/`。不能用 `out/main/../dist`。 */
export function resolveRendererHtml(appPath: string): string {
  return join(appPath, "dist", "index.html");
}

/** unpackaged：相对 main 编译目录；packaged：asar 根下的 build/icon.ico。 */
export function resolveAppIcon(packaged: boolean, appPath: string, mainDir: string): string {
  if (packaged) return join(appPath, 'build', 'icon.ico');
  return join(mainDir, '../../build/icon.ico');
}

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
