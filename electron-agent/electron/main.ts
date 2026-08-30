import { app, BrowserWindow, safeStorage } from "electron";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { browserWindowOptions } from "./mainConfig";
import { SettingsService } from "./app/settingsService";
import { registerIpcHandlers } from "./ipc/register";
import { attachWebviewSecurity } from "./webviewSecurity";
import { TencentDbLayout } from "./tencentdb/layout";
import { TencentDbRuntime } from "./tencentdb/runtime";
import { TencentDbPanelRuntime } from "./tencentdb/panelRuntime";
import { TencentDbService, type TencentDbConfigStore, type TencentDbSecretKey, type TencentDbSecretStore } from "./tencentdb/service";

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
  app.whenReady().then(async () => {
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
      configStore: new JsonTencentDbConfigStore(join(app.getPath('userData'), 'tencentdb-config.json')),
      secrets: new SafeTencentDbSecretStore(join(app.getPath('userData'), 'tencentdb-credentials.json')),
    });
    await tencentdb.load();
    registerIpcHandlers({
      settings: new SettingsService(app.getPath('userData')),
      tencentdb,
    });
    app.on('before-quit', () => {
      void panelRuntime.shutdown();
      void memoryRuntime.stop();
    });
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
}

class JsonTencentDbConfigStore implements TencentDbConfigStore {
  constructor(private readonly path: string) {}

  async read() {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(config: Parameters<TencentDbConfigStore['write']>[0]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  }
}

class SafeTencentDbSecretStore implements TencentDbSecretStore {
  private readonly fallback = new Map<TencentDbSecretKey, string>();

  constructor(private readonly path: string) {}

  async get(key: TencentDbSecretKey): Promise<string | undefined> {
    const values = await this.read();
    const encoded = values[key];
    if (!encoded) return this.fallback.get(key);
    if (!safeStorage.isEncryptionAvailable()) return this.fallback.get(key);
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  }

  async set(key: TencentDbSecretKey, value: string): Promise<void> {
    this.fallback.set(key, value);
    if (!safeStorage.isEncryptionAvailable()) return;
    const values = await this.read();
    values[key] = safeStorage.encryptString(value).toString('base64');
    await this.write(values);
  }

  async clear(key: TencentDbSecretKey): Promise<void> {
    this.fallback.delete(key);
    const values = await this.read();
    delete values[key];
    await this.write(values);
  }

  private async read(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Record<string, string>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  private async write(values: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(values)}\n`, { mode: 0o600 });
  }
}
