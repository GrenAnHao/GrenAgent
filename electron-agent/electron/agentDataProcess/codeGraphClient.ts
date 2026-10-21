import { AgentProcessClient } from '../agentProcess/agentProcessClient';
import { startJobGuard } from '../agentProcess/jobGuard';
import { CodeGraphHostClient } from '../app/codeGraph/codeGraphHostClient';

export interface CodeGraphClientOptions {
  hostEntry: string;
  workerEntry: string;
  jobGuardExe: string;
  /** 拉起 codegraph-host 用的可执行文件（Electron，RunAsNode）。 */
  execPath: string;
  listWorkspaces: () => string[];
  diag: (record: { kind: string } & Record<string, unknown>) => void;
}

/**
 * codegraph-host 子进程的客户端。inproc 模式由主进程持有，child 模式由 agentdata-host 持有
 * （codegraph-host 是它的子进程）；拉起方式、崩溃预算、进程树守卫两边一样。
 */
export function createCodeGraphClient(options: CodeGraphClientOptions): CodeGraphHostClient {
  return new CodeGraphHostClient({
    listWorkspaces: options.listWorkspaces,
    createProcess: (onEvent) => new AgentProcessClient({
      entry: options.hostEntry,
      guard: (pid) => startJobGuard(pid, { exePath: options.jobGuardExe }),
      execPath: options.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CODEGRAPH_WORKER_ENTRY: options.workerEntry },
      hostMethods: {},
      onEvent,
      onExit: (exit) => options.diag({ kind: 'codegraph-host-exit', code: exit.code, signal: exit.signal, expected: exit.expected, stderrTail: exit.stderrTail.slice(-4_000) }),
      log: (stream, line) => (stream === 'stderr' ? console.error : console.log)(`[codegraph-host] ${line}`),
      readyTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000,
    }),
    onDiag: (sample) => options.diag({ kind: 'codegraph-host-sample', ...sample }),
    onSyncEvent: (event) => options.diag({ kind: 'codegraph-sync-event', ...event }),
  });
}
