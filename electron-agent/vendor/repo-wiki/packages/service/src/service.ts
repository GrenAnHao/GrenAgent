/** Reusable application service. Run this in repo-wiki-host, not Electron main/renderer. */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import {
  WorkspaceEngine,
  WorkspaceError,
  type GenerationProvider,
  type WorkspaceEngineOptions,
} from "../../core/src/engine.js";
import {
  providerFromEnvironment,
  providerStatus as environmentProviderStatus,
  ProviderError,
} from "../../core/src/providers.js";
import { cloneRepository, GitError } from "../../core/src/git-auth.js";
import { hash, isKnowledgeOutput, ScannerError } from "../../core/src/scanner.js";
import {
  ContractError,
  validateRequest,
  type Action,
  type ProgressEvent,
  type ProviderMode,
  type ContentTarget,
  type ProcessScope,
} from "../../contracts/src/index.js";

type Data = Record<string, any>;
export type DispatchOptions = Partial<ProcessScope> & { signal?: AbortSignal };
export interface WorkspaceServiceOptions {
  dataDir: string;
  engine?: WorkspaceEngine;
  /** Optional engine hooks; an explicitly injected engine takes precedence. */
  engineOptions?: WorkspaceEngineOptions;
  providerFactory?: (mode: ProviderMode, scope?: DispatchOptions) => GenerationProvider;
  providerStatus?: () => Record<string, unknown>;
  cloneRepository?: typeof cloneRepository;
  /** Empty is explicit unrestricted local-web mode. Electron integration must supply roots. */
  allowedRoots?: string[];
  demoPath?: string;
  /** Compatibility switch: zero disables fs.watch; positive enables notification-driven watching. */
  watchInterval?: number;
  watchDebounce?: number;
  /** Embedded hosts require an explicit generation request even for legacy demo watches. */
  automaticGeneration?: boolean;
  requireStorageTokens?: boolean;
}
type Job = {
  projectId: string;
  runId: string;
  provider: GenerationProvider;
  force: boolean;
  target: ContentTarget;
  controller: AbortController;
  promise?: Promise<void>;
  cleanup?: () => void;
  paused?: boolean;
};
const ACTIVE = new Set(["queued", "running", "cancel_requested"]);
const now = () => new Date().toISOString();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const inside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(".." + path.sep) &&
      !path.isAbsolute(relative))
  );
};
class Canceled extends Error {}
export function safeError(error: unknown): { message: string; status: number } {
  if (error instanceof Error && error.name === "AbortError") return { message: "Operation canceled", status: 499 };
  if (
    error instanceof ContractError ||
    error instanceof WorkspaceError ||
    error instanceof ProviderError ||
    error instanceof GitError ||
    error instanceof ScannerError
  )
    return { message: error.message.slice(0, 500), status: error.status };
  if (error && typeof error === "object" && "code" in error && ["EACCES", "EPERM", "EROFS"].includes(String(error.code)))
    return {
      message: "Cannot write to the project folder. Check folder permissions and whether the location is read-only.",
      status: 403,
    };
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    ["ENOENT", "ENOTDIR"].includes(String(error.code))
  )
    return {
      message: "Project, page, or source file was not found.",
      status: 404,
    };
  return {
    message:
      "Operation failed. Check configuration and try again. Sensitive details were withheld.",
    status: 500,
  };
}

export class WorkspaceService {
  readonly engine: WorkspaceEngine;
  readonly dataDir: string;
  private readonly runsPath: string;
  private readonly factory: (mode: ProviderMode, scope?: DispatchOptions) => GenerationProvider;
  private readonly status: () => Record<string, unknown>;
  private readonly cloneRepository: typeof cloneRepository;
  private readonly roots: string[];
  private hostRootsEnforced = false;
  private readonly demoPath?: string;
  private readonly debounce: number;
  private readonly automaticGeneration: boolean;
  private readonly listeners = new Set<(event: ProgressEvent) => void>();
  private readonly jobs = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private readonly pendingClones = new Map<AbortController, Promise<string>>();
  private readonly observed = new Map<
    string,
    { signature: string; since: number }
  >();
  private readonly attempted = new Map<string, string>();
  private readonly watchState = new Map<string, Data>();
  private runs: Record<string, Data> = Object.create(null);
  private targetRuns: Record<string, Partial<Record<ContentTarget, Data>>> =
    Object.create(null);
  private running = 0;
  private closed = false;
  private pumpScheduled = false;
  private closing?: Promise<void>;
  private readonly scans = new Map<string, { controller: AbortController; promise: Promise<Data>; waiters: Set<symbol> }>();
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private readonly watchTimers = new Map<string, NodeJS.Timeout>();
  private readonly requestContexts = new Map<string, Set<AbortController>>();
  private readonly requests = new Set<Promise<any>>();
  private readonly requestControllers = new Set<AbortController>();
  private readonly watchEnabled: boolean;
  private readonly requireStorageTokens: boolean;
  constructor(options: WorkspaceServiceOptions) {
    if (!options || typeof options.dataDir !== "string")
      throw new ContractError("A private data directory is required");
    // Canonical roots come from the host. Validate only the requested target;
    // unavailable unrelated workspaces must not block service startup.
    this.roots = (options.allowedRoots ?? []).map((root) => path.resolve(root));
    this.hostRootsEnforced = options.allowedRoots !== undefined;
    fs.mkdirSync(options.dataDir, { recursive: true });
    this.dataDir = fs.realpathSync(options.dataDir);
    this.engine = options.engine ?? new WorkspaceEngine(this.dataDir, options.engineOptions);
    this.runsPath = path.join(this.dataDir, "workspace-runs.json");
    this.factory = options.providerFactory ?? ((mode) => providerFromEnvironment(mode));
    this.status = options.providerStatus ?? environmentProviderStatus;
    this.cloneRepository = options.cloneRepository ?? cloneRepository;
    this.demoPath = options.demoPath;
    this.debounce = options.watchDebounce ?? 1000;
    this.automaticGeneration = options.automaticGeneration !== false;
    this.requireStorageTokens = options.requireStorageTokens === true;
    if (!Number.isFinite(this.debounce) || this.debounce < 0)
      throw new ContractError("Invalid watch debounce");
    const interval = options.watchInterval ?? 1500;
    if (!Number.isFinite(interval) || interval < 0)
      throw new ContractError("Invalid watch interval");
    this.watchEnabled = interval > 0;
    if (fs.existsSync(this.runsPath)) {
      const stat = fs.lstatSync(this.runsPath);
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        stat.size > 16 * 1024 * 1024
      )
        throw new ContractError(
          "Run state must be a regular file no larger than 16 MiB",
        );
      try {
        const loaded = JSON.parse(fs.readFileSync(this.runsPath, "utf8"));
        if (loaded && typeof loaded === "object" && !Array.isArray(loaded))
          for (const [id, value] of Object.entries(loaded)) {
            if (
              /^[a-zA-Z0-9_-]+$/.test(id) &&
              value &&
              typeof value === "object" &&
              !Array.isArray(value)
            ) {
              const run = value as Data;
              const history = run.content_runs;
              delete run.content_runs;
              run.target = run.target === "cards" ? "cards" : "wiki";
              run.events = Array.isArray(run.events)
                ? run.events.slice(-100)
                : [];
              this.runs[id] = run;
              this.targetRuns[id] = {};
              for (const target of ["wiki", "cards"] as const) {
                if (
                  history?.[target] &&
                  typeof history[target] === "object" &&
                  !Array.isArray(history[target])
                )
                  this.targetRuns[id][target] = {
                    ...history[target],
                    target,
                    events: Array.isArray(history[target].events)
                      ? history[target].events.slice(-20)
                      : [],
                  };
              }
              this.targetRuns[id][run.target as ContentTarget] = clone(run);
            }
          }
      } catch {
        throw new ContractError(
          "Run state is invalid JSON; preserve the file and restore its backup before restarting",
        );
      }
    }
    for (const run of [
      ...Object.values(this.runs),
      ...Object.values(this.targetRuns).flatMap((targets) =>
        Object.values(targets),
      ),
    ])
      if (ACTIVE.has(run.status))
        Object.assign(run, {
          status: "interrupted",
          stage: "interrupted",
          cancelable: false,
          updated_at: now(),
          message:
            "The service restarted before this run completed; regenerate to resume.",
        });
    this.persist();
    if (this.watchEnabled && this.automaticGeneration) for (const project of this.engine.list_projects()) if (project.watch) this.startWatch(project);
  }
  private realDirectory(input: string): string {
    const expanded =
      input === "~"
        ? os.homedir()
        : input.startsWith("~/")
          ? path.join(os.homedir(), input.slice(2))
          : input;
    try {
      const real = fs.realpathSync(expanded);
      if (!fs.statSync(real).isDirectory()) throw new Error();
      return real;
    } catch {
      throw new WorkspaceError("Repository directory does not exist", 404);
    }
  }
  updateHostRoots(roots: string[]): void {
    if (!Array.isArray(roots) || roots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) throw new ContractError('Invalid host roots');
    this.roots.splice(0, this.roots.length, ...roots.map(root => path.resolve(root)));
    this.hostRootsEnforced = true;
  }
  private authorizePath(input: string): string {
    const real = this.realDirectory(input);
    if ((this.hostRootsEnforced || this.roots.length > 0) && !this.roots.some((root) => inside(root, real)))
      throw new ContractError(
        "This repository is outside the host-approved workspace roots",
        403,
      );
    return real;
  }
  private project(projectId: string): Data {
    const project = this.engine.get_project(projectId);
    this.authorizePath(project.path);
    return project;
  }
  private visibleProjects(): Data[] {
    return this.engine
      .list_projects()
      .filter((project) => {
        try {
          this.authorizePath(project.path);
          return true;
        } catch {
          return false;
        }
      })
      .map((project) => ({
        ...project,
        runs_by_kind: {
          wiki: this.latest(project.id, "wiki", project.identity),
          cards: this.latest(project.id, "cards", project.identity),
        },
      }));
  }
  private persist(): void {
    const ids = Object.keys(this.runs);
    if (ids.length > 200) {
      const active = ids.filter((id) => ACTIVE.has(this.runs[id]!.status));
      const inactive = ids
        .filter((id) => !ACTIVE.has(this.runs[id]!.status))
        .sort((a, b) =>
          String(this.runs[b]!.updated_at).localeCompare(
            String(this.runs[a]!.updated_at),
          ),
        );
      const keep = new Set([
        ...active,
        ...inactive.slice(0, Math.max(0, 200 - active.length)),
      ]);
      for (const id of ids)
        if (!keep.has(id)) {
          delete this.runs[id];
          delete this.targetRuns[id];
        }
    }
    const temporary = path.join(this.dataDir, `.runs-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(
        temporary,
        JSON.stringify(
          Object.fromEntries(
            Object.entries(this.runs).map(([id, run]) => [
              id,
              { ...run, content_runs: this.targetRuns[id] ?? {} },
            ]),
          ),
        ),
        {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        },
      );
      fs.renameSync(temporary, this.runsPath);
    } finally {
      try {
        fs.unlinkSync(temporary);
      } catch {
        /* Already renamed. */
      }
    }
  }
  subscribe(handler: (event: ProgressEvent) => void): () => void {
    if (this.closed) throw new ContractError("Service is shutting down", 503);
    this.listeners.add(handler);
    let subscribed = true;
    return () => {
      if (subscribed) {
        this.listeners.delete(handler);
        subscribed = false;
      }
    };
  }
  private publish(projectId: string): void {
    const event = {
      project_id: projectId,
      run: this.latest(projectId),
      time: now(),
      ...(this.runs[projectId]?.context_id ? { context_id: this.runs[projectId].context_id } : {}),
    } as ProgressEvent;
    for (const listener of this.listeners)
      try {
        listener(clone(event));
      } catch {
        /* Consumer callbacks cannot break generation or persistence. */
      }
  }
  private update(projectId: string, runId: string, values: Data): void {
    const run = this.runs[projectId];
    if (!run || run.id !== runId) return;
    Object.assign(run, values, { updated_at: now() });
    run.events = [
      ...(Array.isArray(run.events) ? run.events : []),
      {
        time: now(),
        stage: run.stage,
        progress: run.progress,
        message: run.message ?? "",
      },
    ].slice(-100);
    this.rememberRun(projectId);
    this.persist();
    this.publish(projectId);
  }
  private rememberRun(projectId: string): void {
    const run = this.runs[projectId];
    this.targetRuns[projectId] ??= {};
    this.targetRuns[projectId][run.target === "cards" ? "cards" : "wiki"] = {
      ...clone(run),
      events: run.events.slice(-20),
    };
  }
  private latest(
    projectId: string,
    target?: ContentTarget,
    currentIdentity?: Data,
  ): Data {
    let run = target
      ? this.targetRuns[projectId]?.[target]
      : this.runs[projectId];
    if (run && currentIdentity && !ACTIVE.has(run.status)) {
      const runIdentity = run.identity ?? run.result?.identity;
      if (
        !runIdentity ||
        runIdentity.branch !== currentIdentity.branch ||
        runIdentity.language !== currentIdentity.language
      )
        run = undefined;
    }
    return clone(
      run ?? {
        id: null,
        status: "idle",
        stage: "idle",
        progress: 0,
        message: "Ready to generate",
        events: [],
        ...(target ? { target } : {}),
      },
    );
  }
  private active(projectId: string): boolean {
    return ACTIVE.has(this.runs[projectId]?.status);
  }
  private submit(
    projectId: string,
    mode: ProviderMode,
    force = false,
    target: ContentTarget = "wiki",
    options: DispatchOptions = {},
    resumeRunId?: string,
  ): Data {
    if (this.closed) throw new ContractError("Service is shutting down", 503);
    const prior = resumeRunId ? Object.values(this.targetRuns[projectId] ?? {}).find((run) => run.id === resumeRunId) : undefined;
    if (prior) {
      if (prior.target !== target || prior.provider !== mode || prior.force !== force) throw new ContractError("Generation task parameters cannot change when resuming", 409);
      if (ACTIVE.has(prior.status) || ["completed", "canceled"].includes(prior.status))
        return { run_id: prior.id, status: prior.status, target };
    }
    if (this.active(projectId))
      throw new ContractError(
        "This project already has a generation in progress",
        409,
      );
    if (this.queue.length >= 100)
      throw new ContractError(
        "Generation queue is full; try again after current jobs complete",
        429,
      );
    // Factories validate configuration only; a provider must never send requests in its constructor.
    const provider = this.factory(mode, options),
      runId = resumeRunId ?? randomUUID();
    if (!provider || typeof provider.generate_page !== "function")
      throw new ContractError("Invalid provider configuration");
    this.runs[projectId] = {
      id: runId,
      run_id: runId,
      status: "queued",
      stage: "queued",
      progress: prior?.progress ?? 0,
      message: prior ? "Resuming unfinished generation" : "Generation queued",
      events: prior?.events ?? [],
      provider: mode,
      force,
      started_at: prior?.started_at ?? now(),
      updated_at: now(),
      cancelable: true,
      target,
      identity: this.engine.changes(projectId, target).identity,
      ...(options.contextId ? { context_id: options.contextId } : {}),
    };
    this.rememberRun(projectId);
    const job: Job = {
      projectId,
      runId,
      provider,
      force,
      target,
      controller: new AbortController(),
    };
    const abort = () => { if (this.jobs.get(projectId) === job) this.cancel(projectId); };
    options.signal?.addEventListener("abort", abort, { once: true });
    job.cleanup = () => options.signal?.removeEventListener("abort", abort);
    this.jobs.set(projectId, job);
    this.queue.push(job);
    this.persist();
    this.publish(projectId);
    this.schedulePump();
    if (options.signal?.aborted) abort();
    return { run_id: runId, status: this.runs[projectId].status, target };
  }
  private schedulePump(): void {
    if (this.pumpScheduled || this.closed) return;
    this.pumpScheduled = true;
    setImmediate(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }
  private pump(): void {
    while (!this.closed && this.running < 2 && this.queue.length) {
      const job = this.queue.shift()!;
      if (job.controller.signal.aborted) continue;
      this.running++;
      job.promise = this.run(job).finally(() => {
        job.cleanup?.();
        this.running--;
        if (this.jobs.get(job.projectId) === job)
          this.jobs.delete(job.projectId);
        this.schedulePump();
      });
    }
  }
  private async run(job: Job): Promise<void> {
    const { projectId, runId, provider, controller } = job;
    const progress = (event: Data): void => {
      if (controller.signal.aborted) throw new Canceled();
      const values: Data = {};
      for (const key of ["stage", "message", "page_id"])
        if (typeof event[key] === "string")
          values[key] = event[key].slice(0, 500);
      if (typeof event.progress === "number" && Number.isFinite(event.progress))
        values.progress = Math.max(0, Math.min(100, event.progress));
      for (const key of ["completed_pages", "total_pages"]) if (typeof event[key] === "number" && Number.isSafeInteger(event[key]) && event[key] >= 0) values[key] = event[key];
      if (event.stage === "committing") values.cancelable = false;
      this.update(projectId, runId, values);
    };
    try {
      this.project(projectId);
      if (controller.signal.aborted) throw new Canceled();
      this.update(projectId, runId, {
        status: "running",
        stage: "scanning",
        message: "Scanning repository",
      });
      const cancellable: GenerationProvider = {
        name: provider.name,
        cache_key: provider.cache_key,
        generate_page: async (context) => {
          if (controller.signal.aborted) throw new Canceled();
          const output = await (
            provider.generate_page as (
              context: Data,
              options: { signal: AbortSignal },
            ) => Promise<Data> | Data
          ).call(provider, context, { signal: controller.signal });
          if (controller.signal.aborted) throw new Canceled();
          return output;
        },
      };
      const result = await this.engine.generate(
        projectId,
        cancellable,
        job.force,
        progress,
        job.target,
        { signal: controller.signal, resumeRunId: runId },
      );
      this.update(projectId, runId, {
        status: "completed",
        stage: "completed",
        progress: 100,
        cancelable: false,
        message: "Generation complete",
        result,
        identity: result.identity,
      });
    } catch (error) {
      if (error instanceof Canceled || controller.signal.aborted)
        this.update(projectId, runId, {
          status: job.paused ? "interrupted" : "canceled",
          stage: job.paused ? "interrupted" : "canceled",
          cancelable: false,
          message: job.paused ? "Generation paused; completed page outputs are saved for resumption."
            : "Generation canceled; staged changes were discarded. An in-flight model call may still incur charges.",
        });
      else {
        const safe = safeError(error);
        this.update(projectId, runId, {
          status: "failed",
          stage: "failed",
          cancelable: false,
          message: safe.message,
          error: safe.message,
        });
      }
    }
  }
  private cancel(projectId: string, pause = false): Data {
    for (const [key, scan] of this.scans) if (key.startsWith(projectId + ":")) { this.scans.delete(key); scan.controller.abort(); }
    const run = this.runs[projectId],
      job = this.jobs.get(projectId);
    if (!run || !ACTIVE.has(run.status) || !job)
      return {
        run_id: run?.id ?? null,
        status: run?.status ?? "idle",
        message: "No active generation to cancel",
      };
    if (run.status === "cancel_requested") {
      if (!pause) job.paused = false;
      return { run_id: run.id, status: run.status, message: run.message };
    }
    if (!run.cancelable)
      throw new ContractError(
        "The atomic save has already started; this run can no longer be canceled.",
        409,
      );
    job.paused = pause;
    job.controller.abort();
    const queued = this.queue.indexOf(job);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      this.jobs.delete(projectId);
      job.cleanup?.();
      this.update(projectId, run.id, {
        status: pause ? "interrupted" : "canceled",
        stage: pause ? "interrupted" : "canceled",
        cancelable: false,
        message: pause ? "Queued generation paused; it can resume after restart." : "Queued generation canceled; no provider request was sent.",
      });
    } else
      this.update(projectId, run.id, {
        status: "cancel_requested",
        message: pause ? "Pausing generation and saving progress for resumption."
          : "Cancellation requested. Waiting for the in-flight provider to return; it may still incur charges.",
      });
    return { run_id: run.id, status: run.status, message: run.message };
  }
  /** Cancel one caller without aborting another context sharing the same scan. */
  private scan(projectId: string, target: ContentTarget, signal?: AbortSignal): Promise<Data> {
    if (signal?.aborted) return Promise.reject(new ContractError("Scan canceled", 409));
    const project = this.engine.get_project(projectId);
    const key = projectId + ":" + target + ":" + hash({ language: project.language ?? "zh", plan: project.plan ?? null });
    let flight = this.scans.get(key);
    if (!flight || flight.controller.signal.aborted) {
      const controller = new AbortController();
      const next = { controller, waiters: new Set<symbol>(), promise: undefined as unknown as Promise<Data> };
      next.promise = Promise.resolve().then(() => this.engine.scan_project(projectId, { target, signal: controller.signal })).finally(() => { if (this.scans.get(key) === next) this.scans.delete(key); });
      this.scans.set(key, next); flight = next;
    }
    const shared = flight, waiter = Symbol(); shared.waiters.add(waiter);
    return new Promise((resolve, reject) => {
      const cleanup = () => { signal?.removeEventListener("abort", abort); shared.waiters.delete(waiter); };
      const abort = () => {
        cleanup();
        if (!shared.waiters.size) { if (this.scans.get(key) === shared) this.scans.delete(key); shared.controller.abort(); }
        reject(new ContractError("Scan canceled", 409));
      };
      signal?.addEventListener("abort", abort, { once: true });
      shared.promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
  }
  cancelContext(contextId: string): Promise<void> {
    for (const controller of this.requestContexts.get(contextId) ?? []) controller.abort();
    for (const job of this.jobs.values()) if (this.runs[job.projectId]?.context_id === contextId && this.runs[job.projectId]?.cancelable) this.cancel(job.projectId);
    return Promise.resolve();
  }
  private startWatch(project: Data): void {
    if (!this.watchEnabled || this.closed || this.watchers.has(project.id)) return;
    try {
      const watcher = fs.watch(this.authorizePath(project.path), { recursive: true, persistent: false }, (event, filename) => {
        const relative = String(filename ?? "").replaceAll("\\", "/");
        if (isKnowledgeOutput(relative) || inside(project.path, this.dataDir) && inside(this.dataDir, path.join(project.path, relative))) return;
        // Windows also reports ancestor directory mtimes after a descendant
        // write. Recursive file events already carry the actual changed path;
        // keep directory rename events so adding/removing source trees counts.
        if (event === "change" && relative) {
          try { if (fs.statSync(path.join(project.path, relative)).isDirectory()) return; } catch {}
        }
        this.notifyChange(project.id);
      });
      watcher.on("error", () => { watcher.close(); this.watchers.delete(project.id); this.watchState.set(project.id, { status: "error", message: "Filesystem watch failed; refresh explicitly to check source changes." }); });
      this.watchers.set(project.id, watcher);
    } catch {
      this.watchState.set(project.id, { status: "error", message: "Filesystem watch unavailable; refresh explicitly to check source changes." });
    }
  }
  /** Notification-driven, debounced refresh. Embedded mode only marks metadata stale. */
  notifyChange(projectId: string): void {
    if (this.closed) return;
    const previous = this.watchTimers.get(projectId); if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.watchTimers.delete(projectId);
      if (this.closed) return;
      if (!this.automaticGeneration) {
        for (const target of ["wiki", "cards"] as const) this.watchState.set(target === "wiki" ? projectId : projectId + ":cards", { status: "needs_generation", target, message: "Source changed. Refresh or generate explicitly.", checked_at: now() });
        return;
      }
      if (this.active(projectId)) { this.notifyChange(projectId); return; }
      void (async () => {
        const project = this.project(projectId); if (!project.watch) return;
        await this.scan(projectId, "wiki");
        if (project.card_count || this.targetRuns[projectId]?.cards) await this.scan(projectId, "cards");
        this.inspectWatch(projectId);
        if (this.observed.has(projectId) || this.observed.has(projectId + ":cards")) {
          const settled = setTimeout(() => { this.watchTimers.delete(projectId); if (!this.closed) this.inspectWatch(projectId); }, this.debounce);
          settled.unref(); this.watchTimers.set(projectId, settled);
        }
      })().catch(error => { if (!this.closed) this.watchState.set(projectId, { status: "error", message: safeError(error).message }); });
    }, Math.max(10, this.debounce));
    timer.unref(); this.watchTimers.set(projectId, timer);
  }
  /** Poll each generated content kind independently; never auto-start an unrequested card collection. */
  inspectWatch(onlyProjectId?: string): void {
    if (this.closed) return;
    const projects = this.visibleProjects().filter((project) => project.watch && (!onlyProjectId || project.id === onlyProjectId));
    const enabled = new Set(
      projects.flatMap((project) => [project.id, project.id + ":cards"]),
    );
    for (const key of this.observed.keys())
      if (!enabled.has(key) && (!onlyProjectId || key === onlyProjectId || key === onlyProjectId + ":cards")) {
        this.observed.delete(key);
        this.attempted.delete(key);
        this.watchState.delete(key);
      }
    for (const project of projects) {
      const projectId = project.id;
      if (this.active(projectId)) continue;
      for (const target of ["wiki", "cards"] as const) {
        const key = target === "wiki" ? projectId : projectId + ":cards";
        if (
          target === "cards" &&
          !project.card_count &&
          !this.targetRuns[projectId]?.cards
        )
          continue;
        try {
          const changes = this.engine.changes(projectId, target);
          const dirty = [
            "changed",
            "added",
            "deleted",
            "renamed",
            "affected_pages",
            "identity_changed",
          ].some((field) =>
            Array.isArray(changes[field])
              ? changes[field].length
              : Boolean(changes[field]),
          );
          if (!dirty) {
            this.observed.delete(key);
            this.attempted.delete(key);
            this.watchState.set(key, {
              status: "watching",
              target,
              message: "Watching local changes",
              checked_at: now(),
            });
            continue;
          }
          if (!this.automaticGeneration) {
            this.watchState.set(key, {
              status: "needs_generation",
              target,
              message: "Source changed. Start an explicit generation to update this content.",
              checked_at: now(),
            });
            continue;
          }
          const { scanned_at: _scannedAt, scan_state: _scanState, ...sourceChanges } = changes;
          const signature = hash(sourceChanges),
            previous = this.observed.get(key);
          if (!previous || previous.signature !== signature) {
            this.observed.set(key, { signature, since: Date.now() });
            this.watchState.set(key, {
              status: "debouncing",
              target,
              message: "Worktree changes detected",
              checked_at: now(),
            });
            continue;
          }
          if (Date.now() - previous.since < this.debounce) continue;
          const last = this.latest(projectId, target, changes.identity);
          const full = this.project(projectId),
            documents = target === "cards" ? full.cards : full.pages;
          if (
            last.provider !== "demo" ||
            documents.some(
              (page: Data) =>
                page.status !== "archived" &&
                (page.provider ?? "demo") !== "demo",
            ) ||
            last.status === "canceled"
          ) {
            this.watchState.set(key, {
              status: "stale",
              target,
              message:
                "Source changed. Start a manual generation to choose an offline or external provider.",
              checked_at: now(),
            });
            continue;
          }
          if (this.attempted.get(key) === signature) continue;
          this.attempted.set(key, signature);
          this.submit(projectId, "demo", false, target);
          this.watchState.set(key, {
            status: "generating",
            target,
            message: "Refreshing with offline demo provider",
            checked_at: now(),
          });
          break; // One active job per project across both content kinds.
        } catch (error) {
          this.watchState.set(key, {
            status: "error",
            target,
            message: safeError(error).message,
            checked_at: now(),
          });
        }
      }
    }
  }
  async dispatch(action: Action | string, input: unknown = {}, options: DispatchOptions = {}): Promise<any> {
    if (options.signal?.aborted) throw new ContractError("Request canceled", 409);
    const controller = new AbortController();
    this.requestControllers.add(controller);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    if (options.contextId) {
      if (!this.requestContexts.has(options.contextId)) this.requestContexts.set(options.contextId, new Set());
      this.requestContexts.get(options.contextId)!.add(controller);
    }
    const request = this.dispatchRequest(action, input, { ...options, signal });
    this.requests.add(request);
    try { return await request; }
    finally {
      this.requests.delete(request);
      this.requestControllers.delete(controller);
      if (options.contextId) { const controllers = this.requestContexts.get(options.contextId); controllers?.delete(controller); if (!controllers?.size) this.requestContexts.delete(options.contextId); }
    }
  }
  private async dispatchRequest(action: Action | string, input: unknown = {}, options: DispatchOptions = {}): Promise<any> {
    if (this.closed) throw new ContractError("Service is shutting down", 503);
    validateRequest(action, input);
    const request = input as Data;
    if (action === "health")
      return {
        status: "ok",
        version: "2.0.0",
        backend: "TypeScript + Node.js · isolated process",
        service_pid: process.pid,
        runtime: process.version,
        provider: this.status(),
        ...(this.demoPath ? { demo_path: this.demoPath } : {}),
        local_only: true,
      };
    if (action === "projects") return this.visibleProjects();
    if (action === "create") {
      const root = this.authorizePath(request.path);
      const project = await this.engine.hydrate_project(
        root,
        request.language ?? "zh",
        request.name,
        { signal: options.signal },
      );
      if (project.watch) this.startWatch(project);
      return project;
    }
    if (action === "clone") {
      const root = path.join(this.dataDir, "repos");
      fs.mkdirSync(root, { recursive: true });
      this.authorizePath(root);
      const controller = new AbortController();
      const abort = () => controller.abort();
      options.signal?.addEventListener("abort", abort, { once: true });
      const promise = this.cloneRepository(request.url, root, {
        signal: controller.signal,
      });
      this.pendingClones.set(controller, promise);
      try {
        const repository = await promise;
        this.authorizePath(repository);
        if (this.closed)
          throw new ContractError("Service is shutting down", 503);
        return await this.engine.hydrate_project(repository, request.language ?? "zh", undefined, { signal: options.signal });
      } finally {
        this.pendingClones.delete(controller);
        options.signal?.removeEventListener("abort", abort);
      }
    }
    const project = this.project(request.project_id);
    switch (action) {
      case "project":
        return {
          ...project,
          runs_by_kind: {
            wiki: this.latest(request.project_id, "wiki", project.identity),
            cards: this.latest(request.project_id, "cards", project.identity),
          },
          watch_status_by_kind: {
            wiki: this.watchState.get(request.project_id) ?? {
              status: project.watch ? "watching" : "disabled",
              target: "wiki",
            },
            cards: this.watchState.get(request.project_id + ":cards") ?? {
              status:
                project.watch && project.card_count ? "watching" : "disabled",
              target: "cards",
            },
          },
          watch_status: this.watchState.get(request.project_id) ?? {
            status: project.watch ? "watching" : "disabled",
            message: project.watch
              ? "Watching local changes"
              : "Watcher disabled",
          },
        };
      case "changes":
        return this.engine.changes(
          request.project_id,
          request.target ?? "wiki",
        );
      case "scan":
        return this.scan(request.project_id, request.target ?? "wiki", options.signal);
      case "generate":
        if (
          (request.provider ?? "demo") === "real" &&
          request.confirm_external !== true
        )
          throw new ContractError(
            "External generation sends source evidence to the configured model and may incur charges. Explicit confirmation is required.",
            403,
          );
        return this.submit(
          request.project_id,
          request.provider ?? "demo",
          request.force ?? false,
          request.target ?? "wiki",
          options,
          request.resume_run_id,
        );
      case "run":
        return this.latest(
          request.project_id,
          request.target,
          request.target ? project.identity : undefined,
        );
      case "cancel":
        return this.cancel(request.project_id, request.pause === true);
      case "page":
        return this.engine.get_page(request.project_id, request.slug);
      case "edit":
        if (this.requireStorageTokens && !request.expected_storage_token) throw new ContractError("Reload the page before editing; its storage token is required", 409);
        return this.engine.edit_page(
          request.project_id,
          request.slug,
          request.markdown,
          request.expected_revision,
          request.expected_storage_token,
        );
      case "resolve":
        if (this.requireStorageTokens && !request.expected_storage_token) throw new ContractError("Reload the page before resolving; its storage token is required", 409);
        return this.engine.resolve_page(
          request.project_id,
          request.slug,
          request.markdown,
          request.expected_revision,
          request.expected_storage_token,
        );
      case "plan":
        if (this.requireStorageTokens && !request.expected_plan_storage_token) throw new ContractError("Reload the plan before editing; its storage token is required", 409);
        if (this.active(request.project_id))
          throw new ContractError(
            "Wait for generation to finish before changing the plan",
            409,
          );
        return this.engine.update_plan(request.project_id, request.plan, request.expected_plan_storage_token);
      case "watch": {
        const result = this.engine.set_watch(
          request.project_id,
          request.enabled,
        );
        if (!request.enabled) {
          this.watchers.get(request.project_id)?.close(); this.watchers.delete(request.project_id);
          const timer = this.watchTimers.get(request.project_id); if (timer) clearTimeout(timer); this.watchTimers.delete(request.project_id);
          for (const key of [
            request.project_id,
            request.project_id + ":cards",
          ]) {
            this.observed.delete(key);
            this.attempted.delete(key);
            this.watchState.delete(key);
          }
        }
        else this.startWatch(result);
        return result;
      }
      case "source":
        return this.engine.read_source(
          request.project_id,
          request.path,
          request.start_line ?? 1,
          request.end_line,
        );
      case "export":
        return this.engine.export_markdown(
          request.project_id,
          request.target ?? "wiki",
        );
      case "import":
        return this.engine.import_markdown(
          request.project_id,
          request.files,
          request.target ?? "wiki",
        );
      default:
        throw new ContractError("Unknown command");
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const watcher of this.watchers.values()) watcher.close(); this.watchers.clear();
    for (const timer of this.watchTimers.values()) clearTimeout(timer); this.watchTimers.clear();
    const scans = [...this.scans.values()]; for (const scan of scans) scan.controller.abort(); this.scans.clear();
    for (const controllers of this.requestContexts.values()) for (const controller of controllers) controller.abort();
    for (const controller of this.requestControllers) controller.abort();
    for (const controller of this.pendingClones.keys()) controller.abort();
    for (const job of [...this.jobs.values()]) {
      if (this.runs[job.projectId]?.cancelable) this.cancel(job.projectId, true);
    }
    this.closing = (async () => {
      await Promise.allSettled(
        [...this.jobs.values()]
          .map((job) => job.promise)
          .filter((promise): promise is Promise<void> => Boolean(promise))
          .concat(
            [...this.pendingClones.values()].map((promise) =>
              promise.then(() => {}),
            ),
          )
          .concat(scans.map(scan => scan.promise.then(() => {})))
          .concat([...this.requests].map(request => request.then(() => {}))),
      );
      this.listeners.clear();
      this.engine.close();
    })();
    return this.closing;
  }
}
