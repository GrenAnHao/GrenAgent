/** Electron-main safe supervisor: no engine, scanner, SQLite or provider imports. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  PROTOCOL_VERSION,
  isWireMessage,
  validateRequest,
  ContractError,
  type Action,
  type RequestMap,
  type ResponseMap,
  type ProgressEvent,
  type ModelComplete,
  type WireMessage,
  type ProcessScope,
} from "../../contracts/src/index.js";
export interface ProcessOptions {
  entry: string;
  dataDir: string;
  executable?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  maxRestarts?: number;
  restartDelayMs?: number;
  complete?: ModelComplete;
  modelCacheKey?: string;
  allowedRoots?: string[];
  demoPath?: string;
}
export class RepoWikiProcessClient {
  private child?: ChildProcess;
  private ready?: Promise<void>;
  private accepting = true;
  private failed = false;
  private stopping?: Promise<void>;
  private restartCount = 0;
  private restartTimer?: NodeJS.Timeout;
  private pending = new Map<
    string,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
      contextId?: string;
    }
  >();
  private completions = new Map<string, { controller: AbortController; scope?: ProcessScope }>();
  private knowledgePending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer?: NodeJS.Timeout }>();
  private knowledgeReverse = new Map<string, AbortController>();
  private knowledgeHandler?: (kind: string, input: any, signal: AbortSignal) => Promise<unknown>;
  private knowledgeStages = new Map<string, object>();
  private knowledgeScope(input: any): string { const fence = input?.fence; return JSON.stringify([input?.taskId, fence?.ledgerId, fence?.controllerEpoch, fence?.ownerId, fence?.generation, input?.phase, input?.itemId, input?.attempt]); }
  private leases = new Map<string, { cacheKey: string; complete: ModelComplete }>();
  private retiredContexts = new Set<string>();
  private events = new EventEmitter();
  private readyReject?: (e: Error) => void;
  readonly options: ProcessOptions;
  constructor(options: ProcessOptions) {
    if (options.complete && !options.modelCacheKey)
      throw new ContractError("Host modelCacheKey is required");
    this.options = options;
  }
  get pid() {
    return this.child?.pid;
  }
  onLifecycle(
    handler: (state: {
      status: string;
      pid?: number;
      message?: string;
    }) => void,
  ) {
    this.events.on("lifecycle", handler);
    return () => this.events.off("lifecycle", handler);
  }
  subscribe(handler: (event: ProgressEvent) => void) {
    this.events.on("progress", handler);
    return () => this.events.off("progress", handler);
  }
  async start(): Promise<void> {
    if (this.failed)
      throw new ContractError(
        "RepoWiki restart budget exhausted; create a new supervisor",
        503,
      );
    if (!this.accepting)
      throw new ContractError("RepoWiki process is stopped", 503);
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyReject = reject;
      const inherited: Record<string, string | undefined> = {};
      for (const key of [
        "PATH",
        "Path",
        "HOME",
        "USERPROFILE",
        "TMP",
        "TEMP",
        "TMPDIR",
        "SystemRoot",
        "WINDIR",
        "LANG",
        "LC_ALL",
        "NODE_EXTRA_CA_CERTS",
      ])
        if (process.env[key]) inherited[key] = process.env[key];
      const env: Record<string, string | undefined> = {
        ...inherited,
        ...this.options.env,
        REPOWIKI_DATA_DIR: this.options.dataDir,
        REPOWIKI_ALLOWED_ROOTS: JSON.stringify(this.options.allowedRoots ?? []),
        REPOWIKI_DEMO_PATH: this.options.demoPath ?? "",
        REPOWIKI_PROVIDER_BRIDGE: "1",
        REPOWIKI_HOST_MODEL_KEY: this.options.modelCacheKey ?? "host-config-v1",
        ELECTRON_RUN_AS_NODE: "1",
      };
      // Resolve from the supervisor's installed package, then pass the unpacked
      // executable path to the isolated child, which may live in another folder.
      try {
        const fromApp = createRequire(typeof __filename === 'string' ? __filename : join(process.cwd(), 'package.json'));
        const fromPackage = createRequire(fromApp.resolve('@vscode/ripgrep'));
        const binary = process.platform === 'win32' ? 'rg.exe' : 'rg';
        env.REPOWIKI_RG_PATH = fromPackage.resolve(`@vscode/ripgrep-${process.platform}-${process.arch}/bin/${binary}`).replace(/([\\/])app\.asar\1/i, '$1app.asar.unpacked$1');
      } catch { /* Grep reports its own missing executable when invoked. */ }
      const child = spawn(
        this.options.executable ?? process.execPath,
        [this.options.entry],
        {
          cwd: this.options.cwd,
          env,
          stdio: ["ignore", "ignore", "pipe", "ipc"],
          serialization: "advanced",
          windowsHide: true,
        },
      );
      this.child = child;
      // Never forward arbitrary stderr (it could contain repository/provider secrets).
      child.stderr?.on("data", () => {});
      const timeout = setTimeout(() => {
        reject(new ContractError("RepoWiki child startup timed out", 504));
        child.kill();
      }, this.options.startupTimeoutMs ?? 10000);
      child.once("error", () => {
        clearTimeout(timeout);
        reject(new ContractError("Cannot start RepoWiki child process", 503));
      });
      child.on("message", (raw) => {
        // A supervisor may have replaced this OS child. Shutdown responses from
        // the current child still matter even after accepting has become false.
        if (this.child !== child) return;
        if (raw && typeof raw === 'object' && (raw as any).v === 1) {
          const m = raw as any;
          if (m.type === 'knowledgeResponse') {
            const pending = this.knowledgePending.get(m.id); if (!pending) return;
            this.knowledgePending.delete(m.id); if (pending.timer) clearTimeout(pending.timer);
            if (!this.knowledgeSizeOk(m)) pending.reject(new Error('FRAME_TOO_LARGE'));
            else if (m.ok) pending.resolve(m.result); else pending.reject(new Error(typeof m.error === 'string' ? m.error : 'KNOWLEDGE_FAILED'));
            return;
          }
          if (m.type === 'knowledgeReverseCancel') { this.knowledgeReverse.get(m.id)?.abort(); this.knowledgeReverse.delete(m.id); return; }
          if (m.type === 'knowledgeReverse') { void this.handleKnowledgeReverse(m, child); return; }
        }
        if (!isWireMessage(raw)) return;
        const m = raw as WireMessage;
        if (m.type === "ready") {
          clearTimeout(timeout);
          this.readyReject = undefined;
          resolve();
          this.events.emit("lifecycle", { status: "ready", pid: m.pid });
          return;
        }
        if (m.type === "response") {
          const p = this.pending.get(m.id);
          if (!p) return;
          clearTimeout(p.timer);
          this.pending.delete(m.id);
          m.ok
            ? p.resolve(m.result)
            : p.reject(new ContractError(m.error.message, m.error.status));
        } else if (m.type === "event") this.events.emit("progress", m.event);
        else if (m.type === "modelRequest")
          void this.complete(m.id, m.input, child, m.scope);
        else if (m.type === "modelCancel") {
          this.completions.get(m.id)?.controller.abort();
          this.completions.delete(m.id);
        }
      });
      child.once("exit", () => {
        clearTimeout(timeout);
        if (this.child !== child) return;
        this.child = undefined;
        this.ready = undefined;
        this.readyReject?.(
          new ContractError("RepoWiki child exited before ready", 503),
        );
        this.readyReject = undefined;
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(
            new ContractError(
              "RepoWiki child exited; request was not completed",
              503,
            ),
          );
        }
        this.pending.clear();
        for (const p of this.knowledgePending.values()) { if (p.timer) clearTimeout(p.timer); p.reject(new Error('KNOWLEDGE_CHILD_EXITED')); }
        this.knowledgePending.clear(); this.knowledgeStages.clear();
        for (const controller of this.knowledgeReverse.values()) controller.abort();
        this.knowledgeReverse.clear();
        for (const c of this.completions.values()) c.controller.abort();
        this.completions.clear();
        this.events.emit("lifecycle", {
          status: this.accepting ? "crashed" : "stopped",
        });
        if (
          this.accepting &&
          this.restartCount < (this.options.maxRestarts ?? 2)
        ) {
          this.restartCount++;
          this.restartTimer = setTimeout(
            () => void this.start().catch(() => {}),
            this.options.restartDelayMs ?? 300,
          );
        } else if (this.accepting) {
          this.failed = true;
          this.events.emit("lifecycle", {
            status: "failed",
            message:
              "Restart budget exhausted. Create a new supervisor to retry.",
          });
        }
      });
    });
    return this.ready;
  }
  private send(message: WireMessage, child = this.child) {
    if (!child?.connected)
      throw new ContractError("RepoWiki child is unavailable", 503);
    child.send(message, () => {});
  }
  private knowledgeSizeOk(value: unknown): boolean { try { return Buffer.byteLength(JSON.stringify(value)) <= 4 * 1024 * 1024; } catch { return false; } }
  setKnowledgeRequestHandler(handler: (kind: string, input: any, signal: AbortSignal) => Promise<unknown>): void { this.knowledgeHandler = handler; }
  private async handleKnowledgeReverse(frame: any, child: ChildProcess): Promise<void> {
    const controller = new AbortController();
    if (typeof frame.id !== 'string' || this.knowledgeReverse.has(frame.id)) return;
    this.knowledgeReverse.set(frame.id, controller);
    try {
      const input = frame.input;
      if (!this.knowledgeSizeOk(frame) || !['model', 'reserve', 'finish', 'markDispatched', 'release'].includes(frame.kind) || !input || !this.knowledgeStages.has(this.knowledgeScope(input)) || !this.knowledgeHandler) throw new Error('INVALID_KNOWLEDGE_SCOPE');
      const result = await this.knowledgeHandler(frame.kind, input, controller.signal);
      const response = { v: 1, type: 'knowledgeReverseResponse', id: frame.id, ok: true, result };
      if (!controller.signal.aborted && this.child === child && child.connected) child.send(this.knowledgeSizeOk(response) ? response : { v: 1, type: 'knowledgeReverseResponse', id: frame.id, ok: false, error: 'FRAME_TOO_LARGE' }, () => {});
    } catch (error) {
      if (!controller.signal.aborted && this.child === child && child.connected) child.send({ v: 1, type: 'knowledgeReverseResponse', id: frame.id, ok: false, error: error instanceof Error ? error.message.slice(0, 500) : 'KNOWLEDGE_REQUEST_FAILED' }, () => {});
    } finally { this.knowledgeReverse.delete(frame.id); }
  }
  async invokeKnowledge(method: string, input: any): Promise<unknown> {
    if (!['host.updateRoots', 'project.read', 'project.readReadme', 'project.prepare', 'project.abortPrepare', 'project.installFence', 'project.preparePublication', 'project.commitPublication', 'project.reconcile', 'project.refreshIndex', 'stage.execute', 'stage.abort'].includes(method)) throw new Error('UNKNOWN_KNOWLEDGE_METHOD');
    const frame = { v: 1, type: 'knowledgeInvoke', id: randomUUID(), method, input };
    if (!this.knowledgeSizeOk(frame)) throw new Error('FRAME_TOO_LARGE');
    await this.start();
    const stageKey = method === 'stage.execute' ? this.knowledgeScope(input) : undefined;
    const stageEntry = stageKey ? {} : undefined;
    if (stageKey && stageEntry) {
      if (!input?.taskId || !input?.fence || this.knowledgeStages.has(stageKey)) throw new Error('INVALID_KNOWLEDGE_SCOPE');
      this.knowledgeStages.set(stageKey, stageEntry);
    }
    try {
      return await new Promise((resolve, reject) => {
        const timer = method.startsWith('stage.') || method === 'project.prepare' || method === 'project.abortPrepare' ? undefined : setTimeout(() => { this.knowledgePending.delete(frame.id); reject(new Error('KNOWLEDGE_REQUEST_TIMEOUT')); }, this.options.requestTimeoutMs ?? 30000);
        this.knowledgePending.set(frame.id, { resolve, reject, timer });
        if (!this.child?.connected) { if (timer) clearTimeout(timer); this.knowledgePending.delete(frame.id); reject(new Error('KNOWLEDGE_CHILD_UNAVAILABLE')); return; }
        this.child.send(frame, error => { if (error) { if (timer) clearTimeout(timer); this.knowledgePending.delete(frame.id); reject(error); } });
      });
    } finally { if (stageKey && this.knowledgeStages.get(stageKey) === stageEntry) this.knowledgeStages.delete(stageKey); }
  }
  async abortStage(input: { taskId: string; fence: unknown }): Promise<unknown> { return this.invokeKnowledge('stage.abort', input); }
  private async complete(
    id: string,
    input: { systemPrompt: string; user: string; maxTokens?: number },
    child: ChildProcess,
    scope?: ProcessScope,
  ) {
    const controller = new AbortController();
    this.completions.set(id, { controller, scope });
    try {
      if (scope && this.retiredContexts.has(scope.contextId)) throw new Error("retired");
      const lease = scope?.modelLeaseId ? this.leases.get(scope.modelLeaseId) : undefined;
      if (scope && (!lease || lease.cacheKey !== scope.modelCacheKey)) throw new Error("Model lease unavailable");
      const complete = scope ? lease?.complete : this.options.complete;
      if (!complete) throw new Error("disabled");
      const text = await complete(input, controller.signal);
      if (typeof text !== "string" || text.length > 2_000_000)
        throw new Error("Invalid completion");
      if (!controller.signal.aborted && this.child === child && child.connected)
        this.send({ v: 1, type: "modelResponse", id, ok: true, text }, child);
    } catch {
      if (this.child === child && child.connected)
        this.send({ v: 1, type: "modelResponse", id, ok: false }, child);
    } finally {
      this.completions.delete(id);
    }
  }
  async invoke<A extends Action>(
    action: A,
    input: RequestMap[A],
  ): Promise<ResponseMap[A]> {
    validateRequest(action, input);
    await this.start();
    return this.request(action, input);
  }
  registerModelLease(id: string, lease: { cacheKey: string; complete: ModelComplete }): () => void {
    if (!id || id.length > 2000 || !lease.cacheKey || lease.cacheKey.length > 2000 || typeof lease.complete !== "function") throw new ContractError("Invalid model lease");
    if (this.leases.has(id)) throw new ContractError("Model lease already registered", 409);
    const fixed = { ...lease };
    this.leases.set(id, fixed);
    return () => {
      if (this.leases.get(id) !== fixed) return;
      this.leases.delete(id);
      for (const completion of this.completions.values()) if (completion.scope?.modelLeaseId === id) completion.controller.abort();
    };
  }
  async invokeScoped<A extends Action>(action: A, input: RequestMap[A], scope: { contextId: string; modelLeaseId?: string }): Promise<ResponseMap[A]> {
    validateRequest(action, input);
    if (!scope.contextId || scope.contextId.length > 200) throw new ContractError("Invalid context");
    if (this.retiredContexts.has(scope.contextId)) throw new ContractError("Context is canceled", 409);
    const lease = scope.modelLeaseId ? this.leases.get(scope.modelLeaseId) : undefined;
    if (scope.modelLeaseId && !lease) throw new ContractError("Model lease unavailable", 409);
    const fixed = { ...scope, ...(lease ? { modelCacheKey: lease.cacheKey } : {}) };
    await this.start();
    if (this.retiredContexts.has(scope.contextId)) throw new ContractError("Context is canceled", 409);
    return this.request(action, input, fixed);
  }
  cancelContext(contextId: string): Promise<void> {
    this.retiredContexts.add(contextId);
    for (const completion of this.completions.values()) if (completion.scope?.contextId === contextId) completion.controller.abort();
    for (const [id, pending] of this.pending) if (pending.contextId === contextId) {
      clearTimeout(pending.timer); this.pending.delete(id);
      pending.reject(new ContractError("Context is canceled", 409));
      try { this.send({ v: 1, type: "cancelRequest", id }); } catch {}
    }
    if (!this.child?.connected) return Promise.resolve();
    return this.requestContextCancel(contextId);
  }
  private requestContextCancel(contextId: string): Promise<void> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new ContractError("Context cancellation timed out", 504)); }, this.options.requestTimeoutMs ?? 30000);
      this.pending.set(id, { resolve: () => resolve(), reject, timer });
      try { this.send({ v: 1, type: "cancelContext", id, contextId }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  private request(action: Action | "shutdown", input: unknown, scope?: ProcessScope): Promise<any> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        try {
          this.send({ v: 1, type: "cancelRequest", id });
        } catch {}
        reject(
          new ContractError(
            "RepoWiki request timed out; cancellation was requested. Check its run status.",
            504,
          ),
        );
      }, this.options.requestTimeoutMs ?? 30000);
      this.pending.set(id, { resolve, reject, timer, contextId: scope?.contextId });
      try {
        this.send({ v: PROTOCOL_VERSION, type: "request", id, action, input, ...(scope ? { scope } : {}) });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.accepting = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.stopping = (async () => {
      const child = this.child;
      if (!child) return;
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      let timer: NodeJS.Timeout | undefined;
      if (child.connected) {
        try {
          await Promise.race([
            this.request("shutdown", {}),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("stop timeout")),
                this.options.stopTimeoutMs ?? 3000,
              );
            }),
          ]);
        } catch {
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null)
              child.kill("SIGKILL");
            resolve();
          }, 1000);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) await exited;
      for (const c of this.completions.values()) c.controller.abort();
      this.completions.clear();
      this.events.removeAllListeners();
    })();
    return this.stopping;
  }
}
