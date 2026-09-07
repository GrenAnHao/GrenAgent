import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { CodeGraph, IndexProgress } from '@colbymchenry/codegraph';
import { readCodeRetrievalTool, validateCodeRetrievalArgs, type CodeRetrievalTool } from '../../agentData/codeRetrievalProtocol';
import type { CodeRetrievalResult } from '../../agentData/codeRetrievalResult';
import { executeCodeGraphTool } from './codeGraphQuery';
import { isIndexed } from './indexProbe';

export const CODEGRAPH_SDK_VERSION = '1.6.0';
export type CodeGraphSdk = Pick<typeof import('@colbymchenry/codegraph'), 'CodeGraph' | 'isInitialized'>;
export interface CodeGraphStatusView {
  workspace: string;
  connected: boolean;
  indexed: boolean;
  sdkAvailable: boolean;
  sdkVersion: string;
  state: 'unavailable' | 'indexed' | 'indexing' | 'partial' | 'failed' | 'stale' | 'sdk_unavailable';
  files?: number;
  nodes?: number;
  edges?: number;
  lastIndexedAt?: number | null;
  message?: string;
}
export interface CodeGraphEngineOptions { loadSdk?: () => Promise<CodeGraphSdk>; idleTimeoutMs?: number }
interface Entry { graph?: CodeGraph; opening?: Promise<CodeGraph>; timer?: ReturnType<typeof setTimeout> }
interface Job { workspace: string; controller: AbortController; promise: Promise<void> }

class SdkUnavailable extends Error {}

/** Instances, reads and explicit index writes share one owner in the Electron process. */
export class CodeGraphEngine {
  private readonly entries = new Map<string, Entry>();
  private readonly reads = new Map<string, Set<Promise<unknown>>>();
  private readonly jobs = new Map<string, Job>();
  private readonly writers = new Map<string, Job>();
  private readonly failures = new Map<string, string>();
  private sdk?: Promise<CodeGraphSdk>;
  private closed = false;
  private shutdown?: Promise<void>;

  constructor(private readonly options: CodeGraphEngineOptions = {}) {}

  async status(workspace: string): Promise<CodeGraphStatusView> {
    const key = this.key(workspace);
    const base = { workspace, connected: false, indexed: isIndexed(workspace), sdkAvailable: true, sdkVersion: CODEGRAPH_SDK_VERSION };
    try {
      this.assertOpen();
      const sdk = await this.load();
      if (this.writers.has(key)) {
        const graph = this.entries.get(key)?.graph;
        return { ...base, ...(graph ? this.snapshot(graph) : {}), state: 'indexing' };
      }
      if (!sdk.isInitialized(workspace)) return { ...base, indexed: false, state: 'unavailable' };
      return await this.read(workspace, async (graph) => ({
        ...base, ...this.snapshot(graph),
        ...(this.failures.has(key) ? { state: 'failed' as const, message: this.failures.get(key) } : {}),
      }));
    } catch (error) {
      const unavailable = error instanceof SdkUnavailable;
      return { ...base, sdkAvailable: !unavailable, state: unavailable ? 'sdk_unavailable' : 'failed', message: errorText(error) };
    }
  }

  async call(workspace: string, tool: CodeRetrievalTool, args: Record<string, unknown>): Promise<CodeRetrievalResult> {
    this.assertOpen();
    const name = readCodeRetrievalTool(tool);
    const validated = validateCodeRetrievalArgs(workspace, name, args);
    return this.read(workspace, (graph) => executeCodeGraphTool(graph, workspace, name, validated));
  }

  async runSync(jobId: string, workspace: string, onProgress?: (progress: IndexProgress) => void): Promise<void> {
    this.assertOpen();
    const key = this.key(workspace);
    if (this.jobs.has(jobId) || this.writers.has(key)) throw new Error('CodeGraph workspace is busy indexing');
    const controller = new AbortController();
    const job: Job = { workspace, controller, promise: Promise.resolve() };
    this.jobs.set(jobId, job);
    this.writers.set(key, job);
    this.clearTimer(key);
    job.promise = Promise.resolve().then(async () => {
      await Promise.allSettled([...(this.reads.get(key) ?? [])]);
      this.checkCancelled(controller.signal);
      const sdk = await this.load();
      this.checkCancelled(controller.signal);
      const initialized = sdk.isInitialized(workspace);
      const graph = await this.graph(workspace, !initialized);
      this.checkCancelled(controller.signal);
      const options = { signal: controller.signal, onProgress: (progress: IndexProgress) => onProgress?.(progress) };
      if (!initialized || graph.getIndexState() !== 'complete' || graph.isIndexStale()) {
        const indexed = await graph.indexAll(options);
        this.checkCancelled(controller.signal);
        if (!indexed.success) throw new Error(indexed.errors?.map((error) => error.message).join('; ') || 'CodeGraph index failed');
        if (graph.getIndexState() !== 'complete') throw new Error('CodeGraph index is partial or interrupted');
      } else {
        // v1.6 sync does not forward signal internally. Do not dispose its DB or
        // report cancellation until the operation has actually settled.
        await graph.sync(options);
        this.checkCancelled(controller.signal);
      }
      this.failures.delete(key);
    }).catch((error) => {
      this.failures.set(key, errorText(error));
      if (controller.signal.aborted) this.checkCancelled(controller.signal);
      throw error;
    }).finally(() => {
      this.jobs.delete(jobId);
      this.writers.delete(key);
      this.scheduleClose(key);
    });
    return job.promise;
  }

  async cancelSync(jobId: string): Promise<void> {
    this.jobs.get(jobId)?.controller.abort();
  }

  close(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.closed = true;
    for (const key of this.entries.keys()) this.clearTimer(key);
    for (const job of this.jobs.values()) job.controller.abort();
    const active = [
      ...[...this.jobs.values()].map((job) => job.promise),
      ...[...this.reads.values()].flatMap((reads) => [...reads]),
      ...[...this.entries.values()].flatMap((entry) => entry.opening ? [entry.opening] : []),
    ];
    this.shutdown = Promise.allSettled(active).then(() => {
      for (const entry of this.entries.values()) entry.graph?.close();
      this.entries.clear();
    });
    return this.shutdown;
  }

  private async read<T>(workspace: string, action: (graph: CodeGraph) => Promise<T>): Promise<T> {
    this.assertOpen();
    const key = this.key(workspace);
    if (this.writers.has(key)) throw new Error('CodeGraph workspace is busy indexing');
    this.clearTimer(key);
    const active = this.reads.get(key) ?? new Set<Promise<unknown>>();
    this.reads.set(key, active);
    const task = this.graph(workspace).then(action);
    active.add(task);
    try { return await task; }
    finally {
      active.delete(task);
      if (!active.size) this.reads.delete(key);
      this.scheduleClose(key);
    }
  }

  private async graph(workspace: string, initialize = false): Promise<CodeGraph> {
    this.assertOpen();
    const sdk = await this.load();
    this.assertOpen();
    if (!initialize && !sdk.isInitialized(workspace)) throw new Error('CodeGraph index is not initialized for this workspace');
    const key = this.key(workspace);
    let entry = this.entries.get(key);
    if (entry?.graph) {
      entry.graph.reopenIfReplaced();
      return entry.graph;
    }
    if (entry?.opening) return entry.opening;
    entry ??= {};
    this.entries.set(key, entry);
    const target = entry;
    target.opening = Promise.resolve().then(async () => {
      this.assertOpen();
      if (!initialize && !sdk.isInitialized(workspace)) throw new Error('CodeGraph index is not initialized for this workspace');
      const graph = initialize ? await sdk.CodeGraph.init(workspace, { index: false }) : await sdk.CodeGraph.open(workspace, { sync: false });
      if (this.closed) { graph.close(); this.assertOpen(); }
      target.graph = graph;
      return graph;
    }).finally(() => { target.opening = undefined; });
    return target.opening;
  }

  private load(): Promise<CodeGraphSdk> {
    if (!this.sdk) {
      this.sdk = Promise.resolve().then(this.options.loadSdk ?? loadEmbeddedSdk).catch((error) => {
        this.sdk = undefined;
        throw new SdkUnavailable(`CodeGraph SDK unavailable: ${errorText(error)}`);
      });
    }
    return this.sdk;
  }

  private snapshot(graph: CodeGraph): Pick<CodeGraphStatusView, 'indexed' | 'connected' | 'state' | 'files' | 'nodes' | 'edges' | 'lastIndexedAt'> {
    const stats = graph.getStats();
    const indexState = graph.getIndexState();
    let state: CodeGraphStatusView['state'] = graph.isIndexStale() ? 'stale' : 'indexed';
    if (indexState === 'indexing' || indexState === 'partial') state = 'partial';
    if (indexState === 'failed') state = 'failed';
    return {
      indexed: true, connected: true,
      state,
      files: stats.fileCount, nodes: stats.nodeCount, edges: stats.edgeCount, lastIndexedAt: graph.getLastIndexedAt(),
    };
  }

  private key(workspace: string): string {
    const path = resolve(workspace);
    return process.platform === 'win32' ? path.toLowerCase() : path;
  }

  private assertOpen(): void { if (this.closed) throw new Error('CodeGraph engine is closed'); }
  private checkCancelled(signal: AbortSignal): void {
    if (signal.aborted) {
      const error = new Error('CodeGraph sync was cancelled; completed index writes are retained');
      error.name = 'AbortError';
      throw error;
    }
  }
  private clearTimer(key: string): void { const entry = this.entries.get(key); if (entry?.timer) { clearTimeout(entry.timer); entry.timer = undefined; } }
  private scheduleClose(key: string): void {
    const entry = this.entries.get(key);
    if (this.closed || !entry?.graph || entry.opening || this.reads.has(key) || this.writers.has(key)) return;
    this.clearTimer(key);
    entry.timer = setTimeout(() => { entry.graph?.close(); this.entries.delete(key); }, this.options.idleTimeoutMs ?? 15 * 60_000);
    entry.timer.unref?.();
  }
}

async function loadEmbeddedSdk(): Promise<CodeGraphSdk> {
  const appRequire = createRequire(import.meta.url);
  // Run SDK workers and resolve its bundled dependencies from real files, not
  // virtual asar paths. package-codegraph.cjs restores the nested dependencies.
  const entry = appRequire.resolve('@colbymchenry/codegraph').replace(/\.asar([/\\])/, '.asar.unpacked$1');
  const sdkRequire = createRequire(entry);
  const manifest = sdkRequire('@colbymchenry/codegraph/package.json') as { version: string };
  if (manifest.version !== CODEGRAPH_SDK_VERSION) throw new Error(`Expected CodeGraph ${CODEGRAPH_SDK_VERSION}, received ${manifest.version}`);
  // Require an installed application dependency: never let the SDK shim fall
  // back to a user's global CLI cache or download a missing platform package.
  sdkRequire.resolve(`@colbymchenry/codegraph-${process.platform}-${process.arch}/package.json`);
  return sdkRequire(entry) as CodeGraphSdk;
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
