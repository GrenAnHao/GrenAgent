import { invoke } from '../platform/runtime';

export interface DevRuntimeMemory {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

/** 与 electron/app/devService.ts 的 DevRuntimeInfo 对齐。 */
export interface DevRuntimeInfo {
  appName: string;
  appVersion: string;
  isPackaged: boolean;
  electron: string;
  chrome: string;
  node: string;
  v8: string;
  platform: string;
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

export const devApi = {
  /** 主进程运行时快照。打包版本里命令未注册，会 reject。 */
  info: () => invoke<DevRuntimeInfo>('dev_runtime_info'),
  /** 主进程当前已注册的 IPC 命令清单（供调试台下拉选择）。 */
  commands: () => invoke<string[]>('dev_list_commands'),
};
