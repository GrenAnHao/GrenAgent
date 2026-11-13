import { AgentProcessClient } from '../agentProcess/agentProcessClient';
import { startJobGuard } from '../agentProcess/jobGuard';
import { CodeGraphHostClient } from '../app/codeGraph/codeGraphHostClient';
import type { CodeGraphSyncEvent } from '../app/codeGraph/hostContract';

export interface CodeGraphClientOptions {
  hostEntry: string;
  workerEntry: string;
  jobGuardExe: string;
  /** 拉起 codegraph-host 用的可执行文件（Electron，RunAsNode）。 */
  execPath: string;
  listWorkspaces: () => string[];
  diag: (record: { kind: string } & Record<string, unknown>) => void;
  /** 登记文件，重启后补同步。不设则子进程只在内存里记。 */
  statePath?: string;
  /** 熔断。由持有任务库的一方写成失败任务。 */
  onBreaker?: (event: CodeGraphSyncEvent) => void;
}

/**
 * 主进程持有的 codegraph-host 客户端，负责拉起、崩溃预算与进程树守卫。
 */
export function createCodeGraphClient(options: CodeGraphClientOptions): CodeGraphHostClient {
  return new CodeGraphHostClient({
    listWorkspaces: options.listWorkspaces,
    createProcess: (onEvent) => new AgentProcessClient({
      entry: options.hostEntry,
      guard: (pid) => startJobGuard(pid, { exePath: options.jobGuardExe }),
      execPath: options.execPath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        CODEGRAPH_WORKER_ENTRY: options.workerEntry,
        ...(options.statePath ? { CODEGRAPH_STATE_PATH: options.statePath } : {}),
      },
      hostMethods: {},
      onEvent,
      onExit: (exit) => options.diag({ kind: 'codegraph-host-exit', code: exit.code, signal: exit.signal, expected: exit.expected, stderrTail: exit.stderrTail.slice(-4_000) }),
      log: (stream, line) => (stream === 'stderr' ? console.error : console.log)(`[codegraph-host] ${line}`),
      readyTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000,
    }),
    onDiag: (sample) => options.diag({ kind: 'codegraph-host-sample', ...sample }),
    onSyncEvent: (event) => {
      options.diag({ kind: 'codegraph-sync-event', ...event });
      if (event.outcome === 'breaker') options.onBreaker?.(event);
    },
  });
}
