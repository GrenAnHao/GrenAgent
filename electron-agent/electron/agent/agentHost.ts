import { getConfig as realGetConfig, watchConfig as realWatchConfig } from '../../../extensions/_shared/runtime-config.js';
import { onResourceReloadRequested as realOnResourceReload } from '../../../extensions/_shared/resource-reload.js';
import type { WorkspaceHandle } from './workspaceHandle.js';

interface Reloadable { dispose(): Promise<void>; reload(): Promise<void> }

export interface AgentHostOptions {
  createHandle: (workspace: string, cwd: string) => Promise<WorkspaceHandle>;
  watchConfig?: typeof realWatchConfig;
  onResourceReloadRequested?: typeof realOnResourceReload;
  getConfig?: typeof realGetConfig;
}

/**
 * 交互主 Agent 的 workspace 注册表。没有全局单例主 Agent；cwd/.pi/权限/session 目录按 workspace 隔离。
 * 空闲时同项目多份 jsonl 共用前景 handle，切换走 handle.switchSession。
 * 前景会话正在跑时，另一个会话另开 handle，不拆掉正在跑的那份。
 */
export class AgentHost {
  /** 每个 workspace 当前前景 handle。命令默认打到它。 */
  private readonly handles = new Map<string, WorkspaceHandle>();
  /** 同一项目里同时活着的 handle（含前景和停靠的忙会话）。 */
  private readonly groups = new Map<string, WorkspaceHandle[]>();
  private readonly opening = new Map<string, Promise<WorkspaceHandle>>();
  private readonly extraOpening = new Map<string, Set<Promise<WorkspaceHandle>>>();
  private readonly closing = new Map<string, Promise<void>>();
  private lastReloadRev: string;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private reloading: Promise<void> | undefined;
  private readonly unwatch: Array<() => void> = [];

  constructor(private readonly options: AgentHostOptions) {
    const getConfig = options.getConfig ?? realGetConfig;
    this.lastReloadRev = getConfig('PI_RELOAD_REV') ?? '';
    const watch = options.watchConfig ?? realWatchConfig;
    const onReload = options.onResourceReloadRequested ?? realOnResourceReload;
    this.unwatch.push(watch((next) => {
      const rev = next.PI_RELOAD_REV ?? '';
      if (rev === this.lastReloadRev) return;
      this.lastReloadRev = rev;
      this.scheduleReload();
    }));
    this.unwatch.push(onReload(() => this.scheduleReload()));
  }

  get(workspace: string): WorkspaceHandle | undefined {
    return this.handles.get(workspace);
  }

  list(workspace: string): WorkspaceHandle[] {
    return [...(this.groups.get(workspace) ?? [])];
  }

  focus(workspace: string, handle: WorkspaceHandle): void {
    const match = (this.groups.get(workspace) ?? []).find((item) => item === handle);
    if (!match) return;
    this.handles.set(workspace, match);
  }

  workspaces(): string[] {
    return [...this.handles.keys()];
  }

  /**
   * MCP 扩展按 ctx.cwd 发布状态；面板按 AgentStore workspace 读。
   * 两键不同时，把 cwd 映射成活着的 handle.workspace。对不上就原样返回，不丢状态。
   */
  workspaceForCwd(publishedPath: string): string {
    for (const list of this.groups.values()) {
      for (const handle of list) {
        if (handle.cwd === publishedPath) return handle.workspace;
      }
    }
    return publishedPath;
  }

  async open(workspace: string, cwd: string): Promise<WorkspaceHandle> {
    const inFlightClose = this.closing.get(workspace);
    if (inFlightClose) await inFlightClose;
    const existing = this.handles.get(workspace);
    if (existing) return existing;
    const inFlight = this.opening.get(workspace);
    if (inFlight) return inFlight;
    const pending = (async () => {
      const handle = await this.options.createHandle(workspace, cwd);
      this.attach(workspace, handle, true);
      return handle;
    })().finally(() => { this.opening.delete(workspace); });
    this.opening.set(workspace, pending);
    return pending;
  }

  /** 再开一个 handle，不替换前景。调用方决定何时 focus。 */
  async openAdditional(workspace: string, cwd: string): Promise<WorkspaceHandle> {
    const inFlightClose = this.closing.get(workspace);
    if (inFlightClose) await inFlightClose;
    const task = this.options.createHandle(workspace, cwd);
    const inflight = this.extraOpening.get(workspace) ?? new Set<Promise<WorkspaceHandle>>();
    inflight.add(task);
    this.extraOpening.set(workspace, inflight);
    try {
      const handle = await task;
      if (this.closing.has(workspace)) {
        await handle.dispose();
        throw new Error('workspace is closing');
      }
      this.attach(workspace, handle, false);
      return handle;
    } finally {
      inflight.delete(task);
      if (inflight.size === 0) this.extraOpening.delete(workspace);
    }
  }

  async evict(workspace: string, handle: WorkspaceHandle): Promise<void> {
    const list = this.groups.get(workspace) ?? [];
    const match = list.find((item) => item === handle);
    if (!match) return;
    const next = list.filter((item) => item !== match);
    if (next.length === 0) {
      this.groups.delete(workspace);
      this.handles.delete(workspace);
    } else {
      this.groups.set(workspace, next);
      if (this.handles.get(workspace) === match) this.handles.set(workspace, next[0]);
    }
    await match.dispose();
  }

  async close(workspace: string): Promise<void> {
    const inFlightClose = this.closing.get(workspace);
    if (inFlightClose) return inFlightClose;
    let release: () => void = () => {};
    const started = new Promise<void>((resolve) => { release = resolve; });
    // closing 先登记，finishClose 下一拍再拆，避免 openAdditional 在登记前把新 handle 挂回来。
    const pending = (async () => {
      await started;
      await this.finishClose(workspace);
    })().finally(() => {
      if (this.closing.get(workspace) === pending) this.closing.delete(workspace);
    });
    this.closing.set(workspace, pending);
    release();
    return pending;
  }

  async closeAll(): Promise<void> {
    for (const off of this.unwatch) off();
    this.unwatch.length = 0;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    const all = new Set([
      ...this.handles.keys(),
      ...this.opening.keys(),
      ...this.groups.keys(),
      ...this.extraOpening.keys(),
    ]);
    await Promise.allSettled([...all].map((w) => this.close(w)));
  }

  private attach(workspace: string, handle: WorkspaceHandle, foreground: boolean): void {
    const list = this.groups.get(workspace) ?? [];
    if (!list.includes(handle)) list.push(handle);
    this.groups.set(workspace, list);
    if (foreground || !this.handles.has(workspace)) this.handles.set(workspace, handle);
  }

  private async finishClose(workspace: string): Promise<void> {
    const inFlightOpen = this.opening.get(workspace);
    if (inFlightOpen) {
      try { await inFlightOpen; } catch { return; }
    }
    const extras = [...(this.extraOpening.get(workspace) ?? [])];
    if (extras.length > 0) await Promise.allSettled(extras);
    const list = this.groups.get(workspace) ?? [];
    const foreground = this.handles.get(workspace);
    const all = foreground && !list.includes(foreground) ? [...list, foreground] : [...list];
    this.groups.delete(workspace);
    this.handles.delete(workspace);
    if (all.length === 0) return;
    await Promise.allSettled(all.map((handle) => handle.dispose()));
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => void this.reloadAll(), 150);
  }

  private reloadAll(): Promise<void> {
    if (this.reloading) return this.reloading;
    const all = new Set<Reloadable>();
    for (const list of this.groups.values()) for (const handle of list) all.add(handle);
    for (const handle of this.handles.values()) all.add(handle);
    this.reloading = Promise.allSettled([...all].map((h) => h.reload())).then(() => undefined).finally(() => { this.reloading = undefined; });
    return this.reloading;
  }
}
