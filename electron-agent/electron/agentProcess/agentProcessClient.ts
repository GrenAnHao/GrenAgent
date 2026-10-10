import { spawn as nodeSpawn } from 'node:child_process';
import { processRegistry } from '../app/processRegistry';
import { RpcPeer, type EventListener, type MethodHandler, type WireMessage } from './rpcPeer';

/** 子进程只用到 ChildProcess 的这一小部分，测试用假对象替换。 */
export interface AgentChild {
  readonly pid?: number;
  readonly connected: boolean;
  readonly stdout?: NodeJS.ReadableStream | null;
  readonly stderr?: NodeJS.ReadableStream | null;
  send(message: WireMessage, callback: (error: Error | null) => void): boolean;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export type SpawnAgentChild = (command: string, args: string[], options: {
  env: NodeJS.ProcessEnv;
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'];
  serialization: 'advanced';
  windowsHide: boolean;
}) => AgentChild;

export interface AgentProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** shutdown() 引起的退出。 */
  expected: boolean;
  /** 子进程退出前经 host.fatal 报告的原因。 */
  fatal?: string;
  stderrTail: string;
}

export interface AgentProcessClientOptions {
  entry: string;
  execPath: string;
  env: NodeJS.ProcessEnv;
  /**
   * 放在入口脚本前面的 Node 参数（调试用）。生产构建的入口是字节码，缓存里记着编译时的 V8 参数指纹：
   * 带上 --max-old-space-size 这类 V8 参数会让整份缓存被拒，子进程起不来。
   */
  nodeArgs?: string[];
  /** 子进程发给主进程的请求。 */
  hostMethods: Record<string, MethodHandler>;
  /** 子进程发来的事件（host.ready / host.fatal 除外）。 */
  onEvent: EventListener;
  onExit?: (exit: AgentProcessExit) => void;
  /**
   * 进程树守卫：拉起后立即调用，就绪要等它；子进程退出时（崩溃或关停）release，清掉残留的子孙进程。
   * 返回 undefined 表示不守卫；reject 时记一行日志，照常运行。
   */
  guard?: (pid: number) => Promise<ProcessTreeGuard | undefined>;
  /** 守卫清理完成，summary 是 helper 的结果行（"swept <n> kept <m>"）。 */
  onSweep?: (summary: string, exit: AgentProcessExit) => void;
  spawn?: SpawnAgentChild;
  killTree?: (pid: number) => Promise<void>;
  log?: (stream: 'stdout' | 'stderr', line: string) => void;
  readyTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  now?: () => number;
}

const STDERR_TAIL_BYTES = 64 * 1024;
/**
 * exit 之后最多再等这么久的 close（stdio 读完），崩溃前最后的堆栈才进得了 stderr 尾巴。
 * 不能只等 close：MCP 服务器等孙进程继承了 stderr，它们不退出 close 就不会来。
 */
const STDIO_DRAIN_MS = 200;
const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 3;
const CRASH_COOLDOWN_MS = 30_000;
const EXIT_GRACE_MS = 5_000;
/** 子进程已经退出，helper 只需清理，正常几十毫秒。 */
const GUARD_RELEASE_MS = 5_000;

export interface ProcessTreeGuard {
  release(): Promise<string>;
}

interface Running {
  child: AgentChild;
  peer: RpcPeer;
  ready: Promise<void>;
  exited: Promise<AgentProcessExit>;
  /** 守卫清理完成（没有守卫时随退出一起完成）。 */
  released: Promise<void>;
}

/**
 * 主进程这一侧的 agent-host 子进程。按需拉起：第一条请求或 start() 时 spawn，
 * 意外退出后下一条请求再拉起；短时间连续崩溃时先停一会儿。
 */
export class AgentProcessClient {
  private running: Running | undefined;
  private stopping = false;
  private crashes: number[] = [];
  private blockedUntil = 0;
  private readonly now: () => number;

  constructor(private readonly options: AgentProcessClientOptions) {
    this.now = options.now ?? Date.now;
  }

  get pid(): number | undefined {
    return this.running?.child.pid;
  }

  get isRunning(): boolean {
    return this.running !== undefined;
  }

  start(): Promise<void> {
    if (this.stopping) return Promise.reject(new Error('AGENT_HOST_STOPPED'));
    if (this.running) return this.running.ready;
    const now = this.now();
    if (now < this.blockedUntil) {
      return Promise.reject(new Error(`AGENT_HOST_CRASH_LOOP: agent 子进程连续崩溃，${Math.ceil((this.blockedUntil - now) / 1000)} 秒后再试`));
    }
    let running: Running;
    try {
      running = this.launch();
    } catch (error) {
      this.recordCrash();
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.running = running;
    return running.ready;
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.start();
    const running = this.running;
    if (!running) throw new Error('AGENT_HOST_EXITED');
    return running.peer.request<T>(method, params);
  }

  /** 先请子进程自己收尾，超时再整树杀掉。之后不再拉起。 */
  async shutdown(): Promise<void> {
    this.stopping = true;
    const running = this.running;
    if (!running) return;
    // 子进程回复后自己退出；这里只等退出，不等回复
    running.peer.request('host.shutdown').catch(() => {});
    const exitedInTime = await withTimeout(running.exited.then(() => true), this.options.shutdownTimeoutMs ?? 10_000, false);
    if (!exitedInTime) {
      const pid = running.child.pid;
      if (pid) await (this.options.killTree ?? ((target) => processRegistry.killTree(target)))(pid).catch(() => {});
      else running.child.kill('SIGKILL');
      await withTimeout(running.exited, EXIT_GRACE_MS, undefined);
    }
    // 守卫清掉收尾时没关干净的子孙进程（例如 cmd 包了一层的 MCP 服务器留下的 node）
    await withTimeout(running.released, GUARD_RELEASE_MS, undefined);
  }

  private launch(): Running {
    // 每次拉起各记一份：旧子进程迟到的 stderr 不能算到新子进程头上
    let stderrTail = '';
    let fatal: string | undefined;
    const spawn = this.options.spawn ?? (nodeSpawn as unknown as SpawnAgentChild);
    const child = spawn(this.options.execPath, [...(this.options.nodeArgs ?? []), this.options.entry], {
      env: this.options.env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'advanced',
      windowsHide: true,
    });

    const peer = new RpcPeer({
      send: (message) => {
        if (!child.connected) throw new Error('AGENT_HOST_DISCONNECTED');
        // 异步失败（通道正在关闭）交给 exit 统一处理：那时在途请求会一起失败
        child.send(message, () => {});
      },
    });
    peer.handleAll(this.options.hostMethods);

    // 子进程加载 pi 和扩展要一两秒，这期间不会拉起任何进程；守卫在此之前就把它放进 Job。
    const guardSetup = child.pid !== undefined && this.options.guard
      ? this.options.guard(child.pid).catch((error: unknown) => {
        this.log('stderr', `process tree guard unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      })
      : Promise.resolve(undefined);

    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const hostReady = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    hostReady.catch(() => {});
    const ready = hostReady.then(() => guardSetup).then(() => undefined);
    ready.catch(() => {});
    let resolveExited!: (exit: AgentProcessExit) => void;
    const exited = new Promise<AgentProcessExit>((resolve) => { resolveExited = resolve; });
    let resolveReleased!: () => void;
    const released = new Promise<void>((resolve) => { resolveReleased = resolve; });

    peer.onEvent((channel, payload) => {
      if (channel === 'host.ready') { resolveReady(); return; }
      if (channel === 'host.fatal') {
        const message = (payload as { message?: unknown } | null)?.message;
        fatal = typeof message === 'string' ? message : String(payload);
        return;
      }
      this.options.onEvent(channel, payload);
    });
    child.on('message', (message) => peer.receive(message));
    this.pipeLines(child.stdout, 'stdout');
    this.pipeLines(child.stderr, 'stderr', (text) => { stderrTail = (stderrTail + text).slice(-STDERR_TAIL_BYTES); });

    const readyTimer = setTimeout(() => {
      rejectReady(new Error('AGENT_HOST_READY_TIMEOUT'));
      child.kill('SIGKILL');
    }, this.options.readyTimeoutMs ?? 120_000);
    readyTimer.unref?.();
    void ready.then(() => clearTimeout(readyTimer), () => clearTimeout(readyTimer));

    let finished = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null, cause?: Error): void => {
      if (finished) return;
      finished = true;
      clearTimeout(readyTimer);
      const exit: AgentProcessExit = {
        code,
        signal,
        expected: this.stopping,
        ...(fatal ? { fatal } : {}),
        stderrTail,
      };
      const reason = cause?.message ?? fatal ?? lastLine(stderrTail);
      const error = new Error(`AGENT_HOST_EXITED: code=${code ?? 'null'} signal=${signal ?? 'null'}${reason ? ` ${reason}` : ''}`);
      peer.close(error);
      rejectReady(error);
      if (this.running?.child === child) this.running = undefined;
      if (!exit.expected) this.recordCrash();
      resolveExited(exit);
      this.options.onExit?.(exit);
      // 崩溃时它拉起的 MCP 服务器、bash、子代理的子孙进程还活着（libuv 只收直接子进程），交给守卫清掉
      void guardSetup
        .then((guard) => guard?.release())
        .then((summary) => { if (summary) this.options.onSweep?.(summary, exit); })
        .catch((error: unknown) => this.log('stderr', `process tree sweep failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(resolveReleased);
    };
    let exitStatus: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    child.on('exit', (code, signal) => {
      exitStatus = { code, signal };
      const drain = setTimeout(() => finish(code, signal), STDIO_DRAIN_MS);
      drain.unref?.();
    });
    child.on('close', (code, signal) => finish(exitStatus?.code ?? code, exitStatus?.signal ?? signal));
    // 已经起来的子进程上的 error（例如 kill 失败）不代表它退出了；只有没拉起来（没有 pid）才算。
    child.on('error', (error) => {
      if (child.pid === undefined) finish(null, null, error);
      else this.log('stderr', `process error: ${error.message}`);
    });

    return { child, peer, ready, exited, released };
  }

  private recordCrash(): void {
    const now = this.now();
    this.crashes = [...this.crashes.filter((at) => now - at < CRASH_WINDOW_MS), now];
    if (this.crashes.length >= CRASH_LIMIT) {
      this.blockedUntil = now + CRASH_COOLDOWN_MS;
      this.crashes = [];
    }
  }

  private pipeLines(stream: NodeJS.ReadableStream | null | undefined, name: 'stdout' | 'stderr', onText?: (text: string) => void): void {
    if (!stream) return;
    let buffered = '';
    stream.setEncoding?.('utf8');
    stream.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      onText?.(text);
      buffered += text;
      let index = buffered.indexOf('\n');
      while (index >= 0) {
        const line = buffered.slice(0, index).replace(/\r$/, '');
        buffered = buffered.slice(index + 1);
        if (line) this.log(name, line);
        index = buffered.indexOf('\n');
      }
    });
    stream.on('end', () => {
      if (buffered) this.log(name, buffered);
      buffered = '';
    });
  }

  private log(stream: 'stdout' | 'stderr', line: string): void {
    if (this.options.log) {
      this.options.log(stream, line);
      return;
    }
    if (stream === 'stderr') console.error(`[agent-host] ${line}`);
    else console.log(`[agent-host] ${line}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function withTimeout<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  return Promise.race([promise, delay(ms).then(() => fallback)]);
}

function lastLine(text: string): string {
  const lines = text.trim().split(/\r?\n/);
  return lines[lines.length - 1] ?? '';
}
