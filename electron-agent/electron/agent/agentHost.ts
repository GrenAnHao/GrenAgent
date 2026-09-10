import { watchConfig as realWatchConfig } from '../../../extensions/_shared/runtime-config.js';
import { onResourceReloadRequested as realOnResourceReload } from '../../../extensions/_shared/resource-reload.js';
import type { WorkspaceHandle } from './workspaceHandle.js';

interface Reloadable { dispose(): Promise<void>; reload(): Promise<void> }

export interface AgentHostOptions {
  createHandle: (workspace: string, cwd: string) => Promise<WorkspaceHandle>;
  watchConfig?: typeof realWatchConfig;
  onResourceReloadRequested?: typeof realOnResourceReload;
}

/**
 * 交互主 Agent 的 workspace 注册表。没有全局单例主 Agent；cwd/.pi/权限/session 目录按 workspace 隔离。
 * 同项目多份 jsonl 共用一个 handle，切换走 handle.switchSession。
 */
export class AgentHost {
  private readonly handles = new Map<string, WorkspaceHandle>();
  private readonly opening = new Map<string, Promise<WorkspaceHandle>>();
  private lastReloadRev = '';
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly unwatch: Array<() => void> = [];

  constructor(private readonly options: AgentHostOptions) {
    const watch = options.watchConfig ?? realWatchConfig;
    const onReload = options.onResourceReloadRequested ?? realOnResourceReload;
    this.unwatch.push(watch((next) => {
      const rev = next.PI_RELOAD_REV ?? '';
      if (rev === this.lastReloadRev) return;
      this.lastReloadRev = rev;
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => void this.reloadAll(), 150);
    }));
    this.unwatch.push(onReload(() => void this.reloadAll()));
  }

  get(workspace: string): WorkspaceHandle | undefined {
    return this.handles.get(workspace);
  }

  async open(workspace: string, cwd: string): Promise<WorkspaceHandle> {
    const existing = this.handles.get(workspace);
    if (existing) return existing;
    const inFlight = this.opening.get(workspace);
    if (inFlight) return inFlight;
    const pending = (async () => {
      const handle = await this.options.createHandle(workspace, cwd);
      this.handles.set(workspace, handle);
      return handle;
    })().finally(() => { this.opening.delete(workspace); });
    this.opening.set(workspace, pending);
    return pending;
  }

  async close(workspace: string): Promise<void> {
    const handle = this.handles.get(workspace);
    if (!handle) return;
    this.handles.delete(workspace);
    await handle.dispose();
  }

  async closeAll(): Promise<void> {
    for (const off of this.unwatch) off();
    this.unwatch.length = 0;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    const all = [...this.handles.keys()];
    await Promise.allSettled(all.map((w) => this.close(w)));
  }

  private async reloadAll(): Promise<void> {
    await Promise.allSettled([...this.handles.values()].map((h: Reloadable) => h.reload()));
  }
}
