import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { AdapterSpec } from "./adapters.js";
import { DapConnection } from "./protocol.js";

export interface StopResult {
  terminated?: boolean;
  reason?: string;
  threadId?: number;
}

// 单个调试会话：spawn adapter，按 DAP 状态机 initialize→launch→setBreakpoints→configurationDone，
// 控制操作（continue/step）等待下一个 stopped/terminated 事件再返回，契合 agent 的同步工具模型。
export class DapClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly conn: DapConnection;
  private readonly initializedEvent: Promise<void>;
  private resolveInitialized: () => void;
  private threadId = 1;
  private terminated = false;
  private readonly breakpoints = new Map<string, number[]>();
  private readonly stopWaiters: Array<(r: StopResult) => void> = [];
  private readonly outputs: string[] = [];

  constructor(
    private readonly adapter: AdapterSpec,
    private readonly cwd: string,
  ) {
    this.child = spawn(adapter.cmd, adapter.args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.conn = new DapConnection(this.child.stdin);
    this.child.stdout.on("data", (chunk: Buffer) => this.conn.feed(chunk));
    this.child.on("exit", () => {
      this.terminated = true;
      this.conn.rejectAll(new Error("调试适配器已退出"));
      this.flush({ terminated: true });
    });
    this.resolveInitialized = () => {};
    this.initializedEvent = new Promise((r) => {
      this.resolveInitialized = r;
    });
    this.conn.onEvent("initialized", () => this.resolveInitialized());
    this.conn.onEvent("stopped", (body) => {
      const b = (body ?? {}) as { reason?: string; threadId?: number };
      if (typeof b.threadId === "number") this.threadId = b.threadId;
      this.flush({ reason: b.reason, threadId: b.threadId });
    });
    this.conn.onEvent("terminated", () => {
      this.terminated = true;
      this.flush({ terminated: true });
    });
    this.conn.onEvent("output", (body) => {
      const b = (body ?? {}) as { output?: string };
      if (b.output) this.outputs.push(b.output);
    });
  }

  private flush(r: StopResult): void {
    for (const w of this.stopWaiters.splice(0)) w(r);
  }

  private waitForStop(timeoutMs = 30_000): Promise<StopResult> {
    if (this.terminated) return Promise.resolve({ terminated: true });
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const onStop = (r: StopResult) => {
        clearTimeout(timer);
        resolve(r);
      };
      timer = setTimeout(() => {
        const i = this.stopWaiters.indexOf(onStop);
        if (i >= 0) this.stopWaiters.splice(i, 1);
        resolve({ reason: "timeout" });
      }, timeoutMs);
      this.stopWaiters.push(onStop);
    });
  }

  async launch(program: string, args: string[], stopOnEntry: boolean): Promise<StopResult> {
    await this.conn.request("initialize", {
      clientID: "pi",
      adapterID: this.adapter.adapterId,
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: "path",
      supportsRunInTerminalRequest: false,
    });
    const stopWaiter = stopOnEntry ? this.waitForStop() : null;
    const launchPromise = this.conn.request("launch", {
      request: "launch",
      program,
      args,
      cwd: this.cwd,
      stopOnEntry,
      console: "internalConsole",
      justMyCode: false,
    });
    await this.initializedEvent;
    for (const [path, lines] of this.breakpoints) await this.sendBreakpoints(path, lines);
    await this.conn.request("configurationDone");
    await launchPromise;
    return stopWaiter ? stopWaiter : { reason: "running" };
  }

  private sendBreakpoints(path: string, lines: number[]): Promise<unknown> {
    return this.conn.request("setBreakpoints", {
      source: { path },
      breakpoints: lines.map((line) => ({ line })),
    });
  }

  async setBreakpoints(path: string, lines: number[]): Promise<unknown> {
    this.breakpoints.set(path, lines);
    return this.sendBreakpoints(path, lines);
  }

  async continue(): Promise<StopResult> {
    const w = this.waitForStop();
    await this.conn.request("continue", { threadId: this.threadId });
    return w;
  }

  async step(kind: "over" | "into" | "out"): Promise<StopResult> {
    const command = kind === "over" ? "next" : kind === "into" ? "stepIn" : "stepOut";
    const w = this.waitForStop();
    await this.conn.request(command, { threadId: this.threadId });
    return w;
  }

  stackTrace(): Promise<unknown> {
    return this.conn.request("stackTrace", { threadId: this.threadId, startFrame: 0, levels: 20 });
  }
  scopes(frameId: number): Promise<unknown> {
    return this.conn.request("scopes", { frameId });
  }
  variables(variablesReference: number): Promise<unknown> {
    return this.conn.request("variables", { variablesReference });
  }
  evaluate(expression: string, frameId?: number): Promise<unknown> {
    return this.conn.request("evaluate", { expression, frameId, context: "repl" });
  }

  drainOutput(): string {
    const s = this.outputs.join("");
    this.outputs.length = 0;
    return s;
  }

  async terminate(): Promise<void> {
    try {
      await this.conn.request("terminate", {}, 3000);
    } catch {
      /* ignore */
    }
    this.dispose();
  }

  dispose(): void {
    try {
      if (process.platform === "win32" && this.child.pid) {
        spawn("taskkill", ["/F", "/T", "/PID", String(this.child.pid)], { stdio: "ignore" });
      } else {
        this.child.kill("SIGKILL");
      }
    } catch {
      /* gone */
    }
  }
}
