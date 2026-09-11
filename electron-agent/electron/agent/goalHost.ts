import type { WorkspaceHandle } from './workspaceHandle.js';

export interface GoalHostOptions {
  create: (workspace: string, sessionId: string, sessionPath: string) => Promise<WorkspaceHandle>;
}

function key(workspace: string, sessionId: string): string {
  return `${workspace}\0${sessionId}`;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** 仅管理「Goal session ≠ 当前可见 session」的 handle。同文件走交互 handle + origin:goal。 */
export class GoalHost {
  private readonly handles = new Map<string, WorkspaceHandle>();

  constructor(private readonly options: GoalHostOptions) {}

  async open(workspace: string, sessionId: string, sessionPath: string): Promise<WorkspaceHandle> {
    const k = key(workspace, sessionId);
    const existing = this.handles.get(k);
    if (existing) return existing;
    const handle = await this.options.create(workspace, sessionId, sessionPath);
    this.handles.set(k, handle);
    return handle;
  }

  get(workspace: string, sessionId: string): WorkspaceHandle | undefined {
    return this.handles.get(key(workspace, sessionId));
  }

  findBySessionPath(sessionPath: string): { workspace: string; sessionId: string; handle: WorkspaceHandle } | undefined {
    const want = normalizePath(sessionPath);
    for (const [k, handle] of this.handles) {
      const file = handle.session.sessionFile;
      if (typeof file === 'string' && normalizePath(file) === want) {
        const sep = k.indexOf('\0');
        return { workspace: k.slice(0, sep), sessionId: k.slice(sep + 1), handle };
      }
    }
    return undefined;
  }

  async dispose(workspace: string, sessionId: string): Promise<void> {
    const k = key(workspace, sessionId);
    const handle = this.handles.get(k);
    if (!handle) return;
    this.handles.delete(k);
    await handle.dispose();
  }

  async disposeAllForWorkspace(workspace: string): Promise<void> {
    const prefix = `${workspace}\0`;
    const ids = [...this.handles.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
    for (const sessionId of ids) await this.dispose(workspace, sessionId);
  }
}
