import { app, BrowserWindow } from 'electron';

export interface DevRuntimeMemory {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

/** 开发者工作台「运行时」页展示的主进程快照。 */
export interface DevRuntimeInfo {
  appName: string;
  appVersion: string;
  isPackaged: boolean;
  electron: string;
  chrome: string;
  node: string;
  v8: string;
  platform: NodeJS.Platform;
  arch: string;
  locale: string;
  pid: number;
  uptimeSec: number;
  windowCount: number;
  paths: {
    appPath: string;
    userData: string;
    logs: string;
    temp: string;
    home: string;
    cwd: string;
  };
  memory: DevRuntimeMemory;
  env: {
    nodeEnv: string;
    rendererUrl: string | null;
    piAgentDir: string | null;
  };
}

/**
 * 仅供开发期诊断：暴露主进程版本、路径与内存占用。
 * 由 main.ts 在 `app.isPackaged === false` 时才注入 registerIpcHandlers，
 * 因此打包产物里根本不会注册这两个命令（调用会得到「命令未注册」）。
 */
export class DevService {
  info(): DevRuntimeInfo {
    const memory = process.memoryUsage();
    return {
      appName: app.getName(),
      appVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      electron: process.versions.electron ?? '-',
      chrome: process.versions.chrome ?? '-',
      node: process.versions.node ?? '-',
      v8: process.versions.v8 ?? '-',
      platform: process.platform,
      arch: process.arch,
      locale: app.getLocale(),
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      windowCount: BrowserWindow.getAllWindows().length,
      paths: {
        appPath: app.getAppPath(),
        userData: app.getPath('userData'),
        logs: app.getPath('logs'),
        temp: app.getPath('temp'),
        home: app.getPath('home'),
        cwd: process.cwd(),
      },
      memory: {
        rss: memory.rss,
        heapTotal: memory.heapTotal,
        heapUsed: memory.heapUsed,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
      },
      env: {
        nodeEnv: process.env.NODE_ENV ?? '',
        rendererUrl: process.env.ELECTRON_RENDERER_URL ?? null,
        piAgentDir: process.env.PI_CODING_AGENT_DIR ?? null,
      },
    };
  }
}
