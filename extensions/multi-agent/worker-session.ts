// 子代理 worker 后端的宿主这一侧（子代理重新设计阶段 3）。
// 每个子代理一个常驻 worker 进程（不做池），同时活着的 worker 超过上限就排队（SUBAGENT_MAX_WORKERS，默认 2）。
// worker 里跑的是和进程内后端同一份建会话代码（worker-host.ts）；这里给出一个代理会话，接口和进程内的
// 会话一样，所以 runEmbeddedSubagent / startContinuableEmbedded / Activation / 收件箱 / 结算通知都不分后端。
// 不再解析 stdout JSONL，也没有首字节 / 静默完成这类只为进程外打印模式存在的超时。

import { spawn, type ChildProcess } from "node:child_process";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { RpcPeer, type WireMessage } from "../_shared/rpc-peer.js";
import { canForwardApproval, forwardApproval, type ApprovalAsker } from "../_shared/approval-route.js";
import { getConfig } from "../_shared/runtime-config.js";
import { currentWorkspaceContext } from "../_shared/workspace-context.js";
import type { AgentSessionLike, ResumedChildSession } from "./activation.js";
import { emitEmbeddedSubagentEvent } from "./embedded-events.js";
import type { ChildSessionOpener, EmbeddedSubagentOpts, OpenedEmbedded, PreparedEmbedded } from "./embedded-runner.js";
import { reportLeakedError } from "../_shared/leak-owner.js";
import { lastSubagentMeta } from "./subagent-meta.js";
import { resolvePiCommand } from "./runner.js";
import type { AgentUpdate } from "./runner.js";
import { killProcessTree, registerSubagentProcess } from "./subagentProcessRegistry.js";
import type {
  SerializedPrepared,
  WorkerOpenRequest,
  WorkerOpened,
  WorkerResumed,
  WorkerSessionState,
  WorkerSnapshot,
} from "./worker-protocol.js";

export const DEFAULT_MAX_WORKERS = 2;
const STDERR_TAIL_BYTES = 8 * 1024;
const DISPOSE_GRACE_MS = 3000;

// ---- 名额：同时活着的 worker 进程数，超过就排队 ----

let activeWorkers = 0;
const slotWaiters: Array<() => void> = [];

export function maxWorkers(): number {
  const n = Number(getConfig("SUBAGENT_MAX_WORKERS") ?? "");
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_MAX_WORKERS;
}

async function acquireWorkerSlot(signal?: AbortSignal): Promise<() => void> {
  while (activeWorkers >= maxWorkers()) {
    if (signal?.aborted) throw new Error("sub-agent was cancelled while waiting for a worker slot");
    await new Promise<void>((resolve) => {
      slotWaiters.push(resolve);
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  if (signal?.aborted) throw new Error("sub-agent was cancelled while waiting for a worker slot");
  activeWorkers += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeWorkers -= 1;
    slotWaiters.shift()?.();
  };
}

export function workerSlotsInUse(): number {
  return activeWorkers;
}

// ---- 进程 ----

interface WorkerConnection {
  child: ChildProcess;
  peer: RpcPeer;
  stderrTail: () => string;
}

function startWorker(cwd: string, ownerCwd: string, runtimeConfigPath: string | undefined): Promise<WorkerConnection> {
  const { cmd, baseArgs } = resolvePiCommand();
  const child = spawn(cmd, [...baseArgs, "--mode", "subagent"], {
    cwd,
    env: {
      ...process.env,
      ...(runtimeConfigPath ? { PI_RUNTIME_CONFIG: runtimeConfigPath } : {}),
      ELECTRON_RUN_AS_NODE: "1",
      NODE_NO_WARNINGS: "1",
      PI_IS_SUBAGENT: "1",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    serialization: "advanced",
    windowsHide: true,
  });
  registerSubagentProcess(ownerCwd, child);
  let stderr = "";
  child.stdout?.resume();
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
  });
  // 带回调发：通道已关时不回调就会在 child 上抛 error 事件，没人接会让 agent-host 崩掉。退出由 exit 统一处理。
  const peer = new RpcPeer({ send: (message: WireMessage) => void child.send(message, () => {}) });
  child.on("error", () => {});
  child.on("message", (message) => peer.receive(message));
  const exitMessage = (code: number | null, signal: NodeJS.Signals | null) =>
    `sub-agent worker exited (${code ?? signal ?? "unknown"})${stderr.trim() ? `: ${stderr.trim().slice(-2000)}` : ""}`;
  child.once("exit", (code, signal) => peer.close(new Error(exitMessage(code, signal))));
  serveApprovals(peer, child);
  return new Promise<WorkerConnection>((resolve, reject) => {
    const off = peer.onEvent((channel) => {
      if (channel !== "ready") return;
      off();
      resolve({ child, peer, stderrTail: () => stderr });
    });
    child.once("error", (error) => reject(new Error(`sub-agent worker failed to start: ${error.message}`)));
    child.once("exit", (code, signal) => reject(new Error(exitMessage(code, signal))));
  });
}

/**
 * worker 里的子代理需要人批准时（approval-route.ts 的 upstream），经这里交给宿主进程里的父会话。
 * worker 那边的子代理被打断会发 approvalCancel 撤回；worker 退出时在途的请求一并撤回。
 */
function serveApprovals(peer: RpcPeer, child: ChildProcess): void {
  const inflight = new Map<string, AbortController>();
  peer.handleAll({
    approval: async (params) => {
      const requestId = String(params.requestId ?? "");
      const controller = new AbortController();
      inflight.set(requestId, controller);
      try {
        return await forwardApproval(typeof params.sessionPath === "string" ? params.sessionPath : undefined, {
          title: String(params.title ?? ""),
          options: Array.isArray(params.options) ? params.options.map(String) : [],
          chain: Array.isArray(params.chain) ? (params.chain as ApprovalAsker[]) : [],
          timeoutMs: Number(params.timeoutMs) > 0 ? Number(params.timeoutMs) : 0,
          signal: controller.signal,
        });
      } finally {
        inflight.delete(requestId);
      }
    },
    approvalCancel: (params) => {
      inflight.get(String(params.requestId ?? ""))?.abort();
      return null;
    },
    // worker 里的 safety 先问能不能问到人：宿主这边父会话可能没有界面、已经关掉，或设置成了 0。
    approvalReachable: (params) => canForwardApproval(typeof params.sessionPath === "string" ? params.sessionPath : undefined),
  });
  child.once("exit", () => {
    for (const controller of inflight.values()) controller.abort();
  });
}

function serializePrepared(prepared: PreparedEmbedded): SerializedPrepared {
  const parentSessionId = prepared.ctx.sessionId?.();
  return {
    childConfig: prepared.childConfig,
    parentPath: prepared.parentPath,
    workspace: prepared.workspace,
    ctx: { origin: "subagent", workspace: prepared.ctx.workspace, cwd: prepared.ctx.cwd, config: prepared.ctx.config },
    ...(parentSessionId ? { parentSessionId } : {}),
  };
}

/** 能过 IPC 的那部分参数：去掉信号和所有回调。 */
function wireOpts(opts: EmbeddedSubagentOpts): WorkerOpenRequest["opts"] {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(opts)) {
    if (key === "signal" || typeof value === "function") continue;
    out[key] = value;
  }
  return { ...(out as WorkerOpenRequest["opts"]), backend: "worker" };
}

// ---- 代理会话 ----

type Listener = (event: AgentSessionEvent) => void;

class WorkerSessionProxy {
  state: WorkerSessionState = { isStreaming: false, isIdle: true, pendingMessageCount: 0 };
  messages: unknown[] = [];
  transcript = "";
  streamingDelta = "";
  structured: { value: unknown } | undefined;
  entries: unknown[] = [];
  exitedWith: string | undefined;
  private disposing = false;
  private forwardUi = true;
  private readonly listeners = new Set<Listener>();
  private readonly preflights = new Map<number, (disposition: unknown) => void>();
  private nextRequest = 1;
  meta: { sessionId?: string; sessionPath: string; workspace: string } = { sessionPath: "", workspace: "" };

  constructor(
    private readonly conn: WorkerConnection,
    private readonly onUpdate?: (update: AgentUpdate) => void,
    /** 这个 worker 托管的子代理；冷恢复时打开后从会话的 subagent_meta 补上。 */
    public childId?: string,
  ) {
    conn.peer.onEvent((channel, payload) => this.onEvent(channel, payload));
    conn.child.once("exit", (code, signal) => this.onExit(code, signal));
  }

  private onEvent(channel: string, payload: unknown): void {
    const p = payload as Record<string, unknown>;
    if (channel === "event") {
      this.state = p.state as WorkerSessionState;
      const event = p.event as AgentSessionEvent;
      for (const listener of [...this.listeners]) {
        try {
          listener(event);
        } catch {
          /* 一个订阅方出错不影响别的 */
        }
      }
      if (this.forwardUi && this.meta.sessionPath) {
        emitEmbeddedSubagentEvent(event as unknown as Record<string, unknown>, this.meta);
      }
    } else if (channel === "update") {
      this.onUpdate?.(p as unknown as AgentUpdate);
    } else if (channel === "preflight") {
      this.preflights.get(p.requestId as number)?.(p.disposition);
    } else if (channel === "leaked") {
      this.onLeaked(p);
    }
  }

  /** worker 里的漏网错误：这个进程只托管这一个子会话，按这个子代理结算（leak-owner.ts）。worker 的 stderr 只留尾巴，这里记一行。 */
  private onLeaked(p: Record<string, unknown>): void {
    const error = new Error(typeof p.message === "string" ? p.message : "unknown error");
    // 正在关的 worker（最多再活几秒）：它的错误不能算到同一个子代理刚恢复出来的新激活头上。
    if (this.disposing) {
      console.error(`[multi-agent] sub-agent ${this.childId ?? "?"} (worker, closing): ${String(p.kind ?? "leaked error")}: ${error.message}`);
      return;
    }
    const owner = this.childId ? reportLeakedError(error, this.childId) : undefined;
    const settled = owner && !owner.handled ? " (already settled)" : "";
    console.error(`[multi-agent] sub-agent ${this.childId ?? "?"} (worker): ${String(p.kind ?? "leaked error")}${settled}: ${error.message}`);
  }

  /** worker 意外退出：会话按出错结束，等待方照常醒来，Activation 据此结算为 error。 */
  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitedWith = `sub-agent worker exited (${code ?? signal ?? "unknown"})`;
    const wasBusy = !this.state.isIdle || this.state.isStreaming;
    this.state = { isStreaming: false, isIdle: true, pendingMessageCount: 0 };
    if (this.disposing) return;
    if (wasBusy || this.messages.length === 0) {
      this.messages = [
        ...this.messages,
        { role: "assistant", content: [], stopReason: "error", errorMessage: this.exitedWith },
      ];
    }
    for (const listener of [...this.listeners]) {
      try {
        listener({ type: "agent_end", messages: [] } as unknown as AgentSessionEvent);
      } catch {
        /* ignore */
      }
    }
  }

  apply(snapshot: WorkerSnapshot): void {
    this.state = { isStreaming: snapshot.isStreaming, isIdle: snapshot.isIdle, pendingMessageCount: snapshot.pendingMessageCount };
    this.messages = snapshot.messages;
    this.transcript = snapshot.transcript;
    this.streamingDelta = snapshot.streamingDelta;
    if (snapshot.hasStructured) this.structured = { value: snapshot.structured };
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.conn.peer.request<T>(method, params);
  }

  fire(method: string, params: Record<string, unknown> = {}): void {
    if (this.exitedWith) return;
    void this.call(method, params).catch(() => {});
  }

  async prompt(text: string, opts: Record<string, unknown> = {}): Promise<void> {
    if (this.exitedWith) throw new Error(this.exitedWith);
    const { preflightResult, ...rest } = opts;
    const requestId = this.nextRequest++;
    if (typeof preflightResult === "function") this.preflights.set(requestId, preflightResult as (d: unknown) => void);
    try {
      this.state = await this.call<WorkerSessionState>("prompt", { text, opts: rest, requestId });
    } finally {
      this.preflights.delete(requestId);
    }
  }

  async abort(): Promise<void> {
    if (this.exitedWith) return;
    try {
      this.state = await this.call<WorkerSessionState>("abort");
    } catch {
      /* worker 已退出 */
    }
  }

  async waitForIdle(): Promise<void> {
    if (this.exitedWith) return;
    try {
      this.apply(await this.call<WorkerSnapshot>("waitForIdle"));
    } catch (error) {
      if (!this.exitedWith) throw error;
    }
  }

  dispose(): void {
    if (this.disposing) return;
    this.disposing = true;
    this.forwardUi = false;
    const { child } = this.conn;
    if (!this.exitedWith) void this.call("dispose").catch(() => {});
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) killProcessTree(child);
    }, DISPOSE_GRACE_MS);
    timer.unref?.();
  }

  stopUiForwarding(): void {
    this.forwardUi = false;
  }

  kill(): void {
    this.disposing = true;
    killProcessTree(this.conn.child);
  }

  session(info: { sessionId?: string; model?: { provider?: string; id?: string }; thinkingLevel?: string }) {
    const self = this;
    return {
      get isStreaming() {
        return self.state.isStreaming;
      },
      get isIdle() {
        return self.state.isIdle;
      },
      get pendingMessageCount() {
        return self.state.pendingMessageCount;
      },
      get messages() {
        return self.messages;
      },
      sessionId: info.sessionId,
      model: info.model,
      thinkingLevel: info.thinkingLevel,
      subscribe(fn: Listener) {
        self.listeners.add(fn);
        return () => {
          self.listeners.delete(fn);
        };
      },
      bindExtensions: async () => undefined,
      prompt: (text: string, opts?: Record<string, unknown>) => self.prompt(text, opts),
      abort: () => self.abort(),
      waitForIdle: () => self.waitForIdle(),
      dispose: () => self.dispose(),
      // 等 worker 确认写进了会话：worker 已经退出时报错，不让调用方以为已经投递。
      sendCustomMessage: (message: unknown, options: unknown) =>
        self.call<null>("sendCustomMessage", { message, options }).then(() => undefined),
    };
  }

  sessionManager(sessionPath: string) {
    const self = this;
    return {
      appendMessage: () => {
        throw new Error("worker sub-agent sessions cannot append messages from the host");
      },
      appendModelChange: () => {},
      appendCustomEntry: (customType: string, data: unknown) => {
        self.entries.push({ type: "custom", customType, data });
        self.fire("appendCustomEntry", { customType, data });
      },
      getSessionFile: () => sessionPath,
      getEntries: () => self.entries,
    };
  }
}

/** worker 后端的开会话方式：起一个 worker 进程，在里面建子会话，返回代理。 */
export const openWorkerChildSession: ChildSessionOpener = async (opts, prepared) => {
  const release = await acquireWorkerSlot(opts.signal);
  let conn: WorkerConnection;
  try {
    conn = await startWorker(opts.cwd, opts.projectCwd ?? opts.cwd, prepared.childConfig.PI_RUNTIME_CONFIG);
  } catch (error) {
    release();
    throw error;
  }
  conn.child.once("exit", release);
  const proxy = new WorkerSessionProxy(conn, opts.onUpdate, opts.agentId);
  let opened: WorkerOpened;
  try {
    const request: WorkerOpenRequest = { opts: wireOpts(opts), prepared: serializePrepared(prepared) };
    opened = await proxy.call<WorkerOpened>("open", request as unknown as Record<string, unknown>);
  } catch (error) {
    proxy.kill();
    throw error;
  }
  proxy.state = opened.state;
  proxy.entries = opened.entries;
  proxy.meta = { ...(opened.sessionId ? { sessionId: opened.sessionId } : {}), sessionPath: opened.sessionPath, workspace: opened.workspace };
  const session = proxy.session(opened);
  const handle: OpenedEmbedded = {
    session: session as unknown as OpenedEmbedded["session"],
    sessionManager: proxy.sessionManager(opened.sessionPath),
    sessionPath: opened.sessionPath,
    workspace: opened.workspace,
    unsub: () => proxy.stopUiForwarding(),
    inheritedEventCount: opened.inheritedEventCount,
    ...(opts.outputSchema
      ? { structured: { captured: () => proxy.structured } as unknown as NonNullable<OpenedEmbedded["structured"]> }
      : {}),
    getTranscript: () => proxy.transcript,
    getStreamingDelta: () => proxy.streamingDelta,
    heartbeat: () => proxy.fire("heartbeat"),
    clearEmitTimer: () => proxy.fire("clearEmitTimer"),
  };
  return handle;
};

/** 冷恢复一个跑在 worker 里的子代理：新起一个 worker，在里面按 JSONL 重建会话。 */
export async function resumeWorkerChildSession(sessionPath: string, childId?: string): Promise<ResumedChildSession> {
  const als = currentWorkspaceContext();
  const cwd = als?.cwd ?? process.cwd();
  const release = await acquireWorkerSlot();
  let conn: WorkerConnection;
  try {
    conn = await startWorker(cwd, cwd, als?.config.PI_RUNTIME_CONFIG);
  } catch (error) {
    release();
    throw error;
  }
  conn.child.once("exit", release);
  const proxy = new WorkerSessionProxy(conn, undefined, childId);
  const ctx = { origin: "subagent" as const, workspace: als?.workspace ?? cwd, cwd, config: { ...(als?.config ?? {}) } };
  let resumed: WorkerResumed;
  try {
    resumed = await proxy.call<WorkerResumed>("resume", { sessionPath, ctx });
  } catch (error) {
    proxy.kill();
    throw error;
  }
  proxy.state = resumed.state;
  proxy.entries = resumed.entries;
  proxy.meta = { ...(resumed.sessionId ? { sessionId: resumed.sessionId } : {}), sessionPath, workspace: ctx.workspace };
  const agentId = lastSubagentMeta(resumed.entries)?.agentId;
  if (!proxy.childId && typeof agentId === "string" && agentId) proxy.childId = agentId;
  return {
    session: proxy.session(resumed) as unknown as AgentSessionLike,
    sessionManager: proxy.sessionManager(sessionPath),
    cwd: resumed.cwd,
    // 子会话在 worker 里，审批路由也登记在 worker 里；宿主这边由 Activation 登记。
    unsub: () => {},
  };
}
