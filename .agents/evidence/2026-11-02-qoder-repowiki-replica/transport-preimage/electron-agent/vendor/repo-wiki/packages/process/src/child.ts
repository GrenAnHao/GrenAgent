/** Exclusive owner of RepoWiki engine, scans, SQLite, provider calls and watcher. */
import { randomUUID } from "node:crypto";
import { WorkspaceService, safeError } from "../../service/src/service.js";
import {
  providerFromEnvironment,
  providerStatus,
} from "../../core/src/providers.js";
import { HostModelProvider } from "./host-provider.js";
import { runLegacySnapshotWorker, snapshotLegacyInWorker } from "./legacy-snapshot.js";
import {
  isWireMessage,
  type WireMessage,
  ContractError,
  type ProcessScope,
} from "../../contracts/src/index.js";

type KnowledgeReverse = (kind: string, input: unknown, signal?: AbortSignal) => Promise<unknown>;
type KnowledgeHost = { invoke(method: string, input: any): Promise<unknown>; close(): Promise<void> };
let childService: WorkspaceService | undefined;
let knowledgeHost: KnowledgeHost | undefined;
const reversePending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }>();
const privateLimit = 4 * 1024 * 1024;
const privateSend = (value: unknown) => { if (process.connected) process.send?.(value, () => {}); };
const privateSizeOk = (value: unknown) => { try { return Buffer.byteLength(JSON.stringify(value)) <= privateLimit; } catch { return false; } };
function reverseRequest(kind: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
  const id = randomUUID(), frame = { v: 1, type: 'knowledgeReverse', id, kind, input };
  if (!privateSizeOk(frame)) return Promise.reject(new Error('FRAME_TOO_LARGE'));
  return new Promise((resolve, reject) => {
    const cleanup = () => { reversePending.delete(id); signal?.removeEventListener('abort', abort); };
    const abort = () => { privateSend({ v: 1, type: 'knowledgeReverseCancel', id }); cleanup(); reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted')); };
    if (signal?.aborted) { abort(); return; }
    reversePending.set(id, { resolve, reject, cleanup }); signal?.addEventListener('abort', abort, { once: true }); privateSend(frame);
  });
}
export function registerKnowledgeChildHost(factory: (service: WorkspaceService, reverse: KnowledgeReverse) => KnowledgeHost): void {
  if (childService) knowledgeHost = factory(childService, reverseRequest);
}
if (!runLegacySnapshotWorker()) {
if (!process.send)
  throw new Error("RepoWiki host must be launched with an IPC channel");
delete process.env.ELECTRON_RUN_AS_NODE;
const send = (value: WireMessage) => {
  if (process.connected) process.send?.(value, () => {});
};
let closing = false,
  sequence = 0;
const instanceId = randomUUID();
const modelRequests = new Map<
  string,
  {
    resolve: (text: string) => void;
    reject: (e: Error) => void;
    cleanup: () => void;
  }
>();
function hostComplete(
  input: { systemPrompt: string; user: string; maxTokens?: number },
  signal?: AbortSignal,
  scope?: ProcessScope,
): Promise<string> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const abort = () => {
      send({ v: 1, type: "modelCancel", id });
      finish(
        new ContractError(
          "Host model call canceled; an in-flight call may still incur charges",
        ),
      );
    };
    const timer = setTimeout(() => {
      send({ v: 1, type: "modelCancel", id });
      finish(new ContractError("Host model completion timed out", 504));
    }, 120000);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      modelRequests.delete(id);
    };
    const finish = (error: Error) => {
      cleanup();
      reject(error);
    };
    modelRequests.set(id, { resolve, reject, cleanup });
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    send({ v: 1, type: "modelRequest", id, input, ...(scope ? { scope } : {}) });
  });
}
const bridge = process.env.REPOWIKI_PROVIDER_BRIDGE === "1";
const embedded = process.env.REPOWIKI_EMBEDDED === "1";
const service = new WorkspaceService({
  dataDir: process.env.REPOWIKI_DATA_DIR ?? ".repowiki-node",
  allowedRoots: JSON.parse(process.env.REPOWIKI_ALLOWED_ROOTS ?? "[]"),
  demoPath: process.env.REPOWIKI_DEMO_PATH || undefined,
  automaticGeneration: !embedded,
  requireStorageTokens: embedded,
  engineOptions: { snapshotLegacy: (from, to, signal) => snapshotLegacyInWorker(process.argv[1]!, from, to, signal) },
  providerFactory: (mode: string, scope) => {
    if (embedded && mode === "demo")
      throw new ContractError("Demo generation is disabled in the host application", 403);
    const modelScope: ProcessScope | undefined = scope?.contextId ? {
      contextId: scope.contextId,
      ...(scope.modelLeaseId ? { modelLeaseId: scope.modelLeaseId } : {}),
      ...(scope.modelCacheKey ? { modelCacheKey: scope.modelCacheKey } : {}),
    } : undefined;
    return bridge && mode === "real"
      ? new HostModelProvider(
          (input, signal) => hostComplete(input, signal, modelScope),
          scope?.modelCacheKey ?? process.env.REPOWIKI_HOST_MODEL_KEY ?? "",
        )
      : providerFromEnvironment(mode as "demo" | "real");
  },
  providerStatus: () =>
    bridge
      ? {
          real_configured: true,
          mode: "host-short-call",
          model: "GrenAgent host configured model",
          keys_in_renderer: false,
        }
      : providerStatus(),
});
childService = service;
const requests = new Map<string, { controller: AbortController; scope?: ProcessScope }>();
// Keep submit controllers until terminal progress: a timeout cancellation can
// arrive just after the queued response was sent but before the host received it.
const generationRequests = new Map<string, { controller: AbortController; runId: string }>();
const retiredContexts = new Set<string>();
service.subscribe((event) => {
  if (["completed", "failed", "canceled", "interrupted"].includes(event.run.status)) for (const [id, request] of generationRequests) if (request.runId === event.run.id) generationRequests.delete(id);
  send({
    v: 1,
    type: "event",
    event: {
      ...event,
      sequence: ++sequence,
      version: 1,
      instance_id: instanceId,
    } as any,
  });
});
async function shutdown() {
  if (closing) return;
  closing = true;
  await knowledgeHost?.close();
  for (const pending of reversePending.values()) { pending.cleanup(); pending.reject(new Error('Service is shutting down')); }
  for (const request of requests.values()) request.controller.abort();
  for (const request of generationRequests.values()) request.controller.abort();
  for (const [id, p] of modelRequests) {
    send({ v: 1, type: "modelCancel", id });
    p.cleanup();
    p.reject(new ContractError("Service is shutting down", 503));
  }
  await service.close();
}
process.on("message", (raw) => {
  if (raw && typeof raw === 'object' && (raw as any).v === 1) {
    const m = raw as any;
    if (m.type === 'knowledgeReverseResponse') {
      const pending = reversePending.get(m.id);
      if (pending) { pending.cleanup(); if (!privateSizeOk(m)) pending.reject(new Error('FRAME_TOO_LARGE')); else if (m.ok) pending.resolve(m.result); else pending.reject(new Error(typeof m.error === 'string' ? m.error : 'KNOWLEDGE_REQUEST_FAILED')); }
      return;
    }
    if (m.type === 'knowledgeInvoke' && typeof m.id === 'string' && typeof m.method === 'string') {
      if (!privateSizeOk(m)) { privateSend({ v: 1, type: 'knowledgeResponse', id: m.id, ok: false, error: 'FRAME_TOO_LARGE' }); return; }
      void Promise.resolve().then(() => { if (!knowledgeHost || closing) throw new Error('KNOWLEDGE_HOST_UNAVAILABLE'); return knowledgeHost.invoke(m.method, m.input); }).then(result => {
        const frame = { v: 1, type: 'knowledgeResponse', id: m.id, ok: true, result };
        privateSend(privateSizeOk(frame) ? frame : { v: 1, type: 'knowledgeResponse', id: m.id, ok: false, error: 'FRAME_TOO_LARGE' });
      }, error => privateSend({ v: 1, type: 'knowledgeResponse', id: m.id, ok: false, error: error instanceof Error ? error.message.slice(0, 500) : 'KNOWLEDGE_FAILED' }));
      return;
    }
  }
  if (!isWireMessage(raw)) return;
  const message = raw as WireMessage;
  if (message.type === "cancelRequest") { (requests.get(message.id) ?? generationRequests.get(message.id))?.controller.abort(); return; }
  if (message.type === "cancelContext") {
    retiredContexts.add(message.contextId);
    for (const request of requests.values()) if (request.scope?.contextId === message.contextId) request.controller.abort();
    void service.cancelContext(message.contextId).then(() => send({ v: 1, type: "response", id: message.id, ok: true, result: { canceled: true } }));
    return;
  }
  if (message.type === "modelResponse") {
    const p = modelRequests.get(message.id);
    if (p) {
      p.cleanup();
      message.ok
        ? p.resolve(message.text ?? "")
        : p.reject(
            new ContractError(
              "Host model request failed; check the configured provider",
            ),
          );
    }
    return;
  }
  if (message.type !== "request") return;
  if (message.action === "shutdown") {
    void shutdown().then(() => {
      send({
        v: 1,
        type: "response",
        id: message.id,
        ok: true,
        result: { stopped: true },
      });
      setTimeout(() => {
        process.disconnect?.();
        process.exit(0);
      }, 25);
    });
    return;
  }
  if (closing) {
    send({
      v: 1,
      type: "response",
      id: message.id,
      ok: false,
      error: { message: "Service is shutting down", status: 503 },
    });
    return;
  }
  if (message.scope && retiredContexts.has(message.scope.contextId)) {
    send({ v: 1, type: "response", id: message.id, ok: false, error: { message: "Context is canceled", status: 409 } }); return;
  }
  const controller = new AbortController();
  requests.set(message.id, { controller, scope: message.scope });
  void service
    .dispatch(message.action, message.input as any, { ...message.scope, signal: controller.signal })
    .then((result) => {
      if (message.action === "generate" && ["queued", "running", "cancel_requested"].includes(result.status) && typeof result.run_id === "string") generationRequests.set(message.id, { controller, runId: result.run_id });
      send({ v: 1, type: "response", id: message.id, ok: true, result });
    })
    .catch((error) => {
      send({
        v: 1,
        type: "response",
        id: message.id,
        ok: false,
        error: safeError(error),
      });
    }).finally(() => { requests.delete(message.id); });
});
process.on("disconnect", () => void shutdown().finally(() => process.exit(0)));
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void shutdown().finally(() => process.exit(0)));
process.on("uncaughtException", () => {
  void shutdown().finally(() => process.exit(1));
});
send({ v: 1, type: "ready", pid: process.pid });
}
