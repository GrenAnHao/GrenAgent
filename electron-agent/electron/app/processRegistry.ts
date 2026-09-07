import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

export type ProcessSignal = NodeJS.Signals | 0;
export type ExecFileImpl = (file: string, args: string[]) => Promise<void>;

export interface RegisteredProcess {
  pid?: number;
  once(event: 'close', listener: () => void): unknown;
}

export interface ProcessRegistryOptions {
  platform?: NodeJS.Platform;
  execFileImpl?: ExecFileImpl;
  signalProcess?: (pid: number, signal: ProcessSignal) => boolean;
  escalationDelayMs?: number;
}

const execFileAsync = promisify(nodeExecFile);

const defaultExecFile: ExecFileImpl = async (file, args) => {
  await execFileAsync(file, args);
};

const defaultSignalProcess = (pid: number, signal: ProcessSignal): boolean => {
  try {
    return process.kill(pid, signal);
  } catch {
    return false;
  }
};

export class ProcessRegistry {
  private readonly entries = new Map<number, string>();
  private readonly platform: NodeJS.Platform;
  private readonly execFileImpl: ExecFileImpl;
  private readonly signalProcess: (pid: number, signal: ProcessSignal) => boolean;
  private readonly escalationDelayMs: number;

  constructor(options: ProcessRegistryOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.execFileImpl = options.execFileImpl ?? defaultExecFile;
    this.signalProcess = options.signalProcess ?? defaultSignalProcess;
    this.escalationDelayMs = options.escalationDelayMs ?? 3_000;
  }

  register(child: RegisteredProcess, label: string): void {
    const pid = child.pid;
    if (!pid) return;
    this.entries.set(pid, label);
    child.once('close', () => this.entries.delete(pid));
  }

  unregister(pid: number): void {
    this.entries.delete(pid);
  }

  pids(): Array<{ pid: number; label: string }> {
    return [...this.entries.entries()].map(([pid, label]) => ({ pid, label }));
  }

  async killTree(pid: number, options: { strict?: boolean } = {}): Promise<void> {
    if (this.platform === 'win32') {
      await this.execFileImpl('taskkill', ['/pid', String(pid), '/T', '/F']).catch((error: unknown) => { if (options.strict) throw error; });
      this.entries.delete(pid);
      return;
    }
    this.signalGroupOrProcess(pid, 'SIGTERM');
    const deadline = Date.now() + this.escalationDelayMs;
    while (Date.now() < deadline) {
      if (!this.signalProcess(pid, 0)) {
        this.entries.delete(pid);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const delivered = this.signalGroupOrProcess(pid, 'SIGKILL');
    if (options.strict && !delivered && this.signalProcess(pid, 0)) throw new Error('process tree cancellation failed');
    this.entries.delete(pid);
  }

  async killAll(): Promise<void> {
    await Promise.all(this.pids().map(({ pid }) => this.killTree(pid)));
  }

  private signalGroupOrProcess(pid: number, signal: NodeJS.Signals): boolean {
    // Long-lived children are spawned with detached:true on POSIX, so the
    // negative pid reaches their whole process group; fall back to the
    // direct pid when the group does not exist.
    return this.signalProcess(-pid, signal) || this.signalProcess(pid, signal);
  }
}

export const processRegistry = new ProcessRegistry();
