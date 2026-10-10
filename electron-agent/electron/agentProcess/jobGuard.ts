import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * agent-host 的进程树守卫（Windows）。pi-job-guard.exe 把 agent-host 放进一个不允许静默脱离的 Job，
 * 它拉起的子孙进程都在里面；release() 关掉 helper 的 stdin，helper 等 agent-host 退出后
 * 结束 Job 里剩下的、没有可见窗口的进程。agent-host 崩溃、正常关停、主进程崩溃都走这一条。
 * 源码见 electron-agent/native/job-guard.c。
 */
export interface JobGuard {
  /** 触发清理并等 helper 结束。返回 helper 的最后一行输出（"swept <n> kept <m>"），拿不到时为空串。 */
  release(): Promise<string>;
}

export interface GuardChild {
  readonly stdin: NodeJS.WritableStream | null;
  readonly stdout: NodeJS.ReadableStream | null;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface JobGuardOptions {
  exePath: string;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  spawn?: (command: string, args: string[], options: {
    stdio: ['pipe', 'pipe', 'ignore'];
    detached: boolean;
    windowsHide: boolean;
  }) => GuardChild;
  readyTimeoutMs?: number;
  /** helper 自己等 agent-host 退出的上限（毫秒），超时它会终止 agent-host 再清理。 */
  waitMs?: number;
  releaseTimeoutMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 5_000;
const DEFAULT_WAIT_MS = 15_000;

/**
 * 启动守卫。非 Windows 或 helper 缺失时返回 undefined（不守卫，照常运行）。
 * helper 起来了但分配失败时 reject，调用方记一行日志后照常运行。
 */
export async function startJobGuard(pid: number, options: JobGuardOptions): Promise<JobGuard | undefined> {
  if ((options.platform ?? process.platform) !== 'win32') return undefined;
  if (!(options.exists ?? existsSync)(options.exePath)) return undefined;
  const spawn = options.spawn ?? (nodeSpawn as unknown as NonNullable<JobGuardOptions['spawn']>);
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  // detached：主进程崩溃时 helper 不能跟着被 libuv 的 Job 杀掉，它要负责收尾
  const child = spawn(options.exePath, ['--pid', String(pid), '--wait-ms', String(waitMs)], {
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: true,
    windowsHide: true,
  });

  let output = '';
  let exited = false;
  let onChange: () => void = () => {};
  const exit = new Promise<void>((resolve) => {
    const done = () => { exited = true; resolve(); onChange(); };
    child.on('exit', done);
    child.on('error', done);
  });
  child.stdout?.setEncoding?.('utf8');
  child.stdout?.on('data', (chunk: string | Buffer) => {
    output += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    onChange();
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => settle(() => reject(new Error('JOB_GUARD_READY_TIMEOUT'))), options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    timer.unref?.();
    let settled = false;
    function settle(done: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      onChange = () => {};
      done();
    }
    onChange = () => {
      const failure = /^error .*$/m.exec(output);
      if (failure) settle(() => reject(new Error(`JOB_GUARD_FAILED: ${failure[0].trim()}`)));
      else if (/^ready\r?$/m.test(output)) settle(resolve);
      else if (exited) settle(() => reject(new Error(`JOB_GUARD_EXITED: ${output.trim()}`)));
    };
    onChange();
  });

  let releasing: Promise<string> | undefined;
  return {
    release() {
      releasing ??= (async () => {
        try { child.stdin?.end(); } catch { /* 已经结束 */ }
        await Promise.race([exit, delay(options.releaseTimeoutMs ?? waitMs + 5_000)]);
        const lines = output.trim().split(/\r?\n/);
        return lines[lines.length - 1]?.startsWith('swept') ? lines[lines.length - 1]! : '';
      })();
      return releasing;
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
