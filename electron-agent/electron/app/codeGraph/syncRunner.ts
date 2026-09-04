import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { processRegistry } from '../processRegistry';
import { isIndexed as defaultIsIndexed } from './indexProbe';

export type SyncMode = 'init' | 'sync';
export interface SyncResult { mode: SyncMode }

export interface CodeGraphSyncRunnerOptions {
  isIndexed?: (workspace: string) => boolean;
  spawnImpl?: typeof spawn;
  killTree?: (pid: number) => Promise<void>;
  /** 覆盖 codegraph 命令（默认读 GREN_CODEGRAPH_COMMAND，与 code-retrieval 扩展一致）。 */
  commandOverride?: () => string | undefined;
}

/** 解析要执行的命令：未建索引 → init，已建索引 → sync（增量）。 */
export function resolveSyncCommand(workspace: string, indexed: boolean, override?: string): { command: string; args: string[] } {
  const action = indexed ? 'sync' : 'init';
  const configured = override?.trim();
  if (configured) {
    const parts = configured.split(/\s+/);
    return { command: parts[0], args: [...parts.slice(1), action, '--path', workspace] };
  }
  return { command: 'codegraph', args: [action, '--path', workspace] };
}

/** 运行 codegraph CLI 完成一次索引建立/同步。同一时刻每个 job 一个子进程。 */
export class CodeGraphSyncRunner {
  private readonly running = new Map<string, { child: ChildProcessWithoutNullStreams; cancelled: boolean }>();

  constructor(private readonly options: CodeGraphSyncRunnerOptions = {}) {}

  run(jobId: string, workspace: string): Promise<SyncResult> {
    const indexed = (this.options.isIndexed ?? defaultIsIndexed)(workspace);
    const override = (this.options.commandOverride ?? (() => process.env.GREN_CODEGRAPH_COMMAND))();
    const { command, args } = resolveSyncCommand(workspace, indexed, override);
    const spawnImpl = this.options.spawnImpl ?? spawn;
    const child = spawnImpl(command, args, { cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    const entry = { child, cancelled: false };
    this.running.set(jobId, entry);
    processRegistry.register(child, `codegraph:${workspace}`);

    return new Promise<SyncResult>((resolve, reject) => {
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer | string) => { stderr += String(chunk); });
      child.once('error', (error: NodeJS.ErrnoException) => {
        this.running.delete(jobId);
        reject(error.code === 'ENOENT'
          ? new Error(`codegraph CLI not found (tried "${command}"); install it or set GREN_CODEGRAPH_COMMAND`)
          : error);
      });
      child.once('close', (code) => {
        const wasCancelled = this.running.get(jobId)?.cancelled ?? false;
        this.running.delete(jobId);
        if (wasCancelled) { reject(new Error('codegraph sync was cancelled')); return; }
        if (code === 0) { resolve({ mode: indexed ? 'sync' : 'init' }); return; }
        reject(new Error(`codegraph ${indexed ? 'sync' : 'init'} exited (${code}): ${stderr.trim().slice(-500) || 'no stderr output'}`));
      });
    });
  }

  /** 请求取消：标记后杀掉进程树，close 回调会把 promise reject 成 cancelled。 */
  cancel(jobId: string): void {
    const entry = this.running.get(jobId);
    if (!entry) return;
    entry.cancelled = true;
    const pid = entry.child.pid;
    if (pid) void (this.options.killTree ?? ((value: number) => processRegistry.killTree(value)))(pid);
  }
}
