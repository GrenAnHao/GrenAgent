import type { IndexProgress } from '@colbymchenry/codegraph';
import type { CodeRetrievalTool } from '../../agentData/codeRetrievalProtocol';
import type { CodeRetrievalResult } from '../../agentData/codeRetrievalResult';
import type { CodeGraphStatusView } from './codeGraphEngine';
import type { CodeSearchView } from './codeGraphService';
import { CODEGRAPH_DIAG_CHANNEL, CODEGRAPH_PROGRESS_CHANNEL, CODEGRAPH_SYNC_EVENT_CHANNEL, type CodeGraphDiagSample, type CodeGraphHostMethod, type CodeGraphProgressEvent, type CodeGraphSyncEvent } from './hostContract';
import { probeProjects, type ProjectIndexState } from './indexProbe';

/** 主进程只用到子进程客户端的这几样（AgentProcessClient 满足）。 */
export interface CodeGraphHostProcess {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  shutdown(): Promise<void>;
  readonly isRunning: boolean;
}

export interface CodeGraphHostClientOptions {
  listWorkspaces: () => string[];
  /** 传入 onEvent 回调，返回子进程客户端。构造时调用一次；子进程按需拉起。 */
  createProcess: (onEvent: (channel: string, payload: unknown) => void) => CodeGraphHostProcess;
  onDiag?: (sample: CodeGraphDiagSample) => void;
  /** 同步失败 / 熔断 / 长时间占锁（自动同步不建 job，靠它留痕）。 */
  onSyncEvent?: (event: CodeGraphSyncEvent) => void;
}

/**
 * CodeGraph 的主进程门面：方法、返回结构、错误文案与原来的进程内 CodeGraphService 一致，
 * 实际执行在 codegraph-host 子进程里。主进程这边只剩 IPC 收发与 projects() 的一次 stat 探测。
 */
export class CodeGraphHostClient {
  private readonly process: CodeGraphHostProcess;
  private readonly progress = new Map<string, (progress: IndexProgress) => void>();
  private closed = false;
  private closing?: Promise<void>;

  constructor(private readonly options: CodeGraphHostClientOptions) {
    this.process = options.createProcess((channel, payload) => this.onEvent(channel, payload));
  }

  projects(): ProjectIndexState[] { return probeProjects(this.options.listWorkspaces()); }

  async status(workspace: string): Promise<CodeGraphStatusView> {
    if (this.closed) throw new Error('CodeGraph engine is closed');
    return this.request<CodeGraphStatusView>('codegraph.status', { workspace });
  }

  async call(workspace: string, tool: CodeRetrievalTool, args: Record<string, unknown>): Promise<CodeRetrievalResult> {
    if (this.closed) throw new Error('CodeGraph engine is closed');
    return this.request<CodeRetrievalResult>('codegraph.call', { workspace, tool, args });
  }

  async search(workspace: string, query: string, limit: number): Promise<CodeSearchView> {
    try {
      return await this.request<CodeSearchView>('codegraph.search', { workspace, query, limit });
    } catch (error) {
      // 与进程内实现一致：search 永远返回视图，不抛错（子进程不可用也一样）。
      return { workspace, available: false, results: [], message: error instanceof Error ? error.message : String(error) };
    }
  }

  async runSync(jobId: string, workspace: string, onProgress?: (progress: IndexProgress) => void): Promise<void> {
    if (this.closed) throw new Error('CodeGraph engine is closed');
    if (onProgress) this.progress.set(jobId, onProgress);
    try {
      // 同一工作区有同步在跑时子进程让它排队（进度先报 queued），不再报 busy。
      await this.request('codegraph.runSync', { jobId, workspace });
    } finally {
      this.progress.delete(jobId);
    }
  }

  async cancelSync(jobId: string): Promise<void> {
    // 子进程不在：没有在跑的同步可取消（它退出时在途 runSync 已经以 CODEGRAPH_HOST_EXITED 失败）。
    if (!this.process.isRunning) return;
    await this.request('codegraph.cancelSync', { jobId });
  }

  /** 子进程收尾时会先取消在跑的同步并等它结束，再关库退出。 */
  close(): Promise<void> {
    this.closed = true;
    this.closing ??= this.process.shutdown();
    return this.closing;
  }

  private request<T>(method: CodeGraphHostMethod, params: Record<string, unknown>): Promise<T> {
    return this.process.request<T>(method, params);
  }

  private onEvent(channel: string, payload: unknown): void {
    if (channel === CODEGRAPH_PROGRESS_CHANNEL) {
      const event = payload as CodeGraphProgressEvent | null;
      if (event && typeof event.jobId === 'string') this.progress.get(event.jobId)?.(event.progress);
      return;
    }
    if (channel === CODEGRAPH_DIAG_CHANNEL) { this.options.onDiag?.(payload as CodeGraphDiagSample); return; }
    if (channel === CODEGRAPH_SYNC_EVENT_CHANNEL && payload && typeof payload === 'object') this.options.onSyncEvent?.(payload as CodeGraphSyncEvent);
  }
}
