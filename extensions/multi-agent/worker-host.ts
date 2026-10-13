// 子代理 worker 进程这一侧（`pi-worker --mode subagent`）：一个进程托管一个子会话，经 IPC RPC 听宿主指挥。
// 会话就是进程内后端的同一份代码建的（openEmbeddedChildSession / openResumedChildSession），这里只把
// 会话操作（prompt / abort / waitForIdle / dispose …）暴露成 RPC 方法，把会话事件和状态推回宿主。
// Activation、收件箱、结算通知、超时看门狗都留在宿主（agent-host）里，两个后端共用一套。

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { RpcPeer, type WireMessage } from "../_shared/rpc-peer.js";
import { setApprovalUpstream, type ApprovalOutcome } from "../_shared/approval-route.js";
import { runInWorkspace, type WorkspaceContext } from "../_shared/workspace-context.js";
import { openResumedChildSession } from "./activation.js";
import { openEmbeddedChildSession, type EmbeddedSubagentOpts, type PreparedEmbedded } from "./embedded-runner.js";
import { currentChild, rejectionWasHandled, reportLeakedError, trackUnhandledRejection } from "../_shared/leak-owner.js";
import { guardListener } from "../_shared/guard-listener.js";
import type { WorkerOpenRequest, WorkerResumeRequest, WorkerSessionState, WorkerSnapshot } from "./worker-protocol.js";

interface HostedSession {
  session: {
    isStreaming: boolean;
    pendingMessageCount: number;
    messages: unknown[];
    prompt: (text: string, opts?: Record<string, unknown>) => Promise<unknown> | unknown;
    abort: () => Promise<unknown> | unknown;
    waitForIdle: () => Promise<void>;
    dispose: () => void;
    subscribe?: (fn: (event: AgentSessionEvent) => void) => () => void;
    sendCustomMessage?: (msg: unknown, opts: unknown) => unknown;
  };
  sessionManager: { appendCustomEntry: (type: string, data: unknown) => void };
  getTranscript?: () => string;
  getStreamingDelta?: () => string;
  heartbeat?: () => void;
  clearEmitTimer?: () => void;
  unsub?: () => void;
  structured?: { captured: () => { value: unknown } | undefined };
}

/** structured clone 不了的事件（带函数之类）退回 JSON。 */
function cloneable<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

function idleOf(session: HostedSession["session"]): boolean {
  const idle = (session as { isIdle?: unknown }).isIdle;
  return typeof idle === "boolean" ? idle : !session.isStreaming;
}

export async function runSubagentWorker(): Promise<void> {
  const send = process.send?.bind(process);
  if (!send) throw new Error("pi-worker --mode subagent needs an IPC channel");
  const peer = new RpcPeer({ send: (message: WireMessage) => void send(message) });
  process.on("message", (message) => peer.receive(message));
  process.on("disconnect", () => process.exit(0));
  // 漏网错误：这个进程只托管一个子会话，都算它的。原来除了 EPIPE 一律悄悄吞掉，现在记到 stderr，
  // 再交给宿主按这个子代理结算（_shared/leak-owner.ts）。进程照旧不退出。
  const leaked = (kind: string, error: unknown, childId: string | undefined): void => {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "EPIPE") return;
    // 这个子代理在 worker 里又派的进程内孙代理：归到孙代理的（不管它还在不在跑）就交给它，不算到 worker 托管的子代理头上。
    const local = reportLeakedError(error, childId);
    console.error(`[pi-worker] ${kind}${local ? ` (sub-agent ${local.childId}${local.handled ? "" : ", already settled"})` : ""}`, error);
    if (local) return;
    try {
      peer.emit("leaked", { kind, message: error instanceof Error ? error.message : String(error) });
    } catch {
      /* 宿主已经断开 */
    }
  };
  process.on("uncaughtException", (error) => leaked("uncaughtException", error, currentChild()));
  // 等一会儿再算：期间被接住（rejectionHandled）的不是漏网错误。
  process.on("unhandledRejection", (reason, promise) =>
    trackUnhandledRejection(reason, promise, (late, childId) => leaked("unhandledRejection", late, childId)),
  );
  process.on("rejectionHandled", (promise) => rejectionWasHandled(promise));
  // 父会话在宿主进程里：这个进程里的子会话（和它派的孙代理）要人批准时，经 RPC 交给宿主去查父会话。
  setApprovalUpstream({
    reachable: async (sessionPath) => (await peer.request<boolean>("approvalReachable", { sessionPath })) === true,
    ask: async (sessionPath, request) => {
      if (request.signal?.aborted) return { outcome: "cancelled" };
      const requestId = randomUUID();
      const withdraw = () => void peer.request("approvalCancel", { requestId }).catch(() => {});
      request.signal?.addEventListener("abort", withdraw, { once: true });
      try {
        return await peer.request<ApprovalOutcome>("approval", {
          requestId,
          sessionPath,
          title: request.title,
          options: request.options,
          chain: request.chain,
          timeoutMs: request.timeoutMs,
        });
      } catch {
        return { outcome: "unavailable" };
      } finally {
        request.signal?.removeEventListener("abort", withdraw);
      }
    },
  });

  let hosted: HostedSession | undefined;
  let ctx: WorkspaceContext | undefined;
  let stopForwarding: (() => void) | undefined;

  const need = (): HostedSession => {
    if (!hosted) throw new Error("subagent worker has no session yet");
    return hosted;
  };
  const inCtx = <T>(fn: () => T): T => (ctx ? runInWorkspace(ctx, fn) : fn());
  const state = (): WorkerSessionState => {
    const s = need().session;
    return { isStreaming: s.isStreaming === true, isIdle: idleOf(s), pendingMessageCount: s.pendingMessageCount ?? 0 };
  };
  const snapshot = (): WorkerSnapshot => {
    const h = need();
    const captured = h.structured?.captured();
    return {
      ...state(),
      messages: cloneable(h.session.messages),
      transcript: h.getTranscript?.() ?? "",
      streamingDelta: h.getStreamingDelta?.() ?? "",
      ...(captured ? { structured: cloneable(captured.value), hasStructured: true } : {}),
    };
  };
  const forward = (h: HostedSession) => {
    // 宿主断开、事件克隆失败时这里会抛；监听方出错不能抛回 SDK（_shared/guard-listener.ts）。
    const onEvent = guardListener("worker event forwarding", (event: AgentSessionEvent) =>
      peer.emit("event", { event: cloneable(event), state: state() }),
    );
    const off = h.session.subscribe?.(onEvent);
    stopForwarding = () => {
      off?.();
      onEvent.report();
    };
  };

  peer.handleAll({
    open: async (params) => {
      const { opts, prepared } = params as unknown as WorkerOpenRequest;
      ctx = {
        ...prepared.ctx,
        ...(prepared.parentSessionId ? { sessionId: () => prepared.parentSessionId } : {}),
      };
      const full: PreparedEmbedded = { ...prepared, ctx: ctx as PreparedEmbedded["ctx"], cleanup: () => {} };
      const childOpts: EmbeddedSubagentOpts = {
        ...opts,
        onUpdate: (update) => peer.emit("update", cloneable(update)),
      };
      const opened = await inCtx(() => openEmbeddedChildSession(childOpts, full));
      hosted = opened as unknown as HostedSession;
      forward(hosted);
      return {
        sessionId: opened.session.sessionId,
        sessionPath: opened.sessionPath,
        workspace: opened.workspace,
        model: opened.session.model ? { provider: opened.session.model.provider, id: opened.session.model.id } : undefined,
        thinkingLevel: (opened.session as { thinkingLevel?: string }).thinkingLevel,
        inheritedEventCount: opened.inheritedEventCount,
        entries: cloneable(opened.sessionManager.getEntries()),
        state: state(),
      };
    },
    resume: async (params) => {
      const { sessionPath, ctx: resumeCtx } = params as unknown as WorkerResumeRequest;
      ctx = resumeCtx;
      const resumed = await inCtx(() => openResumedChildSession(sessionPath));
      hosted = resumed as unknown as HostedSession;
      forward(hosted);
      const session = resumed.session as unknown as { sessionId?: string; model?: { provider?: string; id?: string } };
      return {
        sessionId: session.sessionId,
        sessionPath,
        cwd: resumed.cwd,
        model: session.model ? { provider: session.model.provider, id: session.model.id } : undefined,
        entries: cloneable(resumed.sessionManager.getEntries()),
        state: state(),
      };
    },
    prompt: async (params) => {
      const text = String(params.text ?? "");
      const opts = (params.opts ?? {}) as Record<string, unknown>;
      const requestId = params.requestId;
      await inCtx(() =>
        need().session.prompt(text, {
          ...opts,
          preflightResult: (disposition: unknown) => peer.emit("preflight", { requestId, disposition: cloneable(disposition) }),
        }),
      );
      return state();
    },
    abort: async () => {
      await need().session.abort();
      return state();
    },
    waitForIdle: async () => {
      await need().session.waitForIdle();
      return snapshot();
    },
    snapshot: () => snapshot(),
    appendCustomEntry: (params) => {
      need().sessionManager.appendCustomEntry(String(params.customType), params.data);
      return null;
    },
    sendCustomMessage: async (params) => {
      await inCtx(() => need().session.sendCustomMessage?.(params.message, params.options));
      return null;
    },
    heartbeat: () => {
      need().heartbeat?.();
      return null;
    },
    clearEmitTimer: () => {
      need().clearEmitTimer?.();
      return null;
    },
    dispose: () => {
      stopForwarding?.();
      const h = hosted;
      hosted = undefined;
      try {
        h?.unsub?.();
        h?.clearEmitTimer?.();
        h?.session.dispose();
      } finally {
        // 先把回复发出去再退出。
        setTimeout(() => process.exit(0), 50);
      }
      return null;
    },
  });
  peer.emit("ready", { pid: process.pid });
}
