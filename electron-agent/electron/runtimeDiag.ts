import { app, BrowserWindow, type WebContents } from 'electron';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';

/**
 * 主进程运行诊断：每 10 秒往 <logs>/runtime-diag.jsonl 写一行。
 *
 * 交互 Agent 和子代理现在跑在 agent-host 子进程里；主进程这边仍要知道自己有没有被卡住。
 * 这里记的是定位要用的最小集合：各进程内存、主进程 V8 堆、事件循环延迟、渲染层 JS 堆、
 * 这段时间里最耗主线程的 IPC 命令、推给渲染层的事件数和因帧已销毁被丢掉的推送数，
 * 以及渲染/子进程退出的原因（agent-host 退出记为 kind: 'agent-host-exit'）。
 */

const INTERVAL_MS = 10_000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** 渲染进程崩了自动重载，10 分钟内最多 3 次，避免崩溃循环。 */
const RELOAD_WINDOW_MS = 10 * 60_000;
const MAX_RELOADS = 3;
const RELOAD_DELAY_MS = 1_500;
const RENDERER_PROBE_MS = 2_000;
const MB = 1024 * 1024;

interface IpcStat {
  n: number;
  ms: number;
  maxMs: number;
}

const ipcStats = new Map<string, IpcStat>();
const eventCounts = new Map<string, number>();
let droppedSends = 0;
let writeRecord: ((record: Record<string, unknown>) => void) | undefined;

/** 写一行带 kind 的事件记录（例如 agent-host 子进程退出）。诊断没启动时丢弃。 */
export function recordDiagEvent(record: { kind: string } & Record<string, unknown>): void {
  writeRecord?.(record);
}

/** 一次 invoke 命令在主进程里花了多久（含 await）。 */
export function recordIpc(command: string, ms: number): void {
  const stat = ipcStats.get(command) ?? { n: 0, ms: 0, maxMs: 0 };
  stat.n += 1;
  stat.ms += ms;
  if (ms > stat.maxMs) stat.maxMs = ms;
  ipcStats.set(command, stat);
}

/** 推给渲染层的一条事件。key 用通道 + 来源，例如 pi://event:subagent。 */
export function recordEventSend(key: string): void {
  eventCounts.set(key, (eventCounts.get(key) ?? 0) + 1);
}

/** 渲染帧已销毁或崩溃，这条推送被跳过。 */
export function recordDroppedSend(): void {
  droppedSends += 1;
}

/** 帧已经没了还 send，Electron 会为每条打一整段堆栈；先判断，跳过并计数。 */
export function canSendTo(contents: WebContents): boolean {
  if (contents.isDestroyed() || contents.isCrashed()) return false;
  try {
    const frame = contents.mainFrame;
    return Boolean(frame) && !frame.isDestroyed() && !frame.detached;
  } catch {
    return false;
  }
}

const round = (bytes: number): number => Math.round((bytes / MB) * 10) / 10;

function topIpc(): Array<{ command: string; n: number; ms: number; maxMs: number }> {
  return [...ipcStats.entries()]
    .map(([command, s]) => ({ command, n: s.n, ms: Math.round(s.ms), maxMs: Math.round(s.maxMs) }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 10);
}

async function rendererHeap(contents: WebContents): Promise<unknown> {
  if (!canSendTo(contents)) return 'gone';
  const probe = contents
    .executeJavaScript(
      '(() => { const m = performance.memory; return m ? [m.usedJSHeapSize, m.totalJSHeapSize, m.jsHeapSizeLimit] : null; })()',
      true,
    )
    .then((value: unknown) => (Array.isArray(value) ? value.map((n) => round(Number(n))) : value))
    .catch((error: unknown) => `error: ${(error as Error)?.message ?? String(error)}`);
  const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), RENDERER_PROBE_MS).unref());
  return Promise.race([probe, timeout]);
}

export function startRuntimeDiag(dir: string = app.getPath('logs')): () => void {
  const file = join(dir, 'runtime-diag.jsonl');
  let chain: Promise<void> = mkdir(dir, { recursive: true }).then(() => undefined, () => undefined);

  const write = (record: Record<string, unknown>): void => {
    const line = `${JSON.stringify({ t: new Date().toISOString(), ...record })}\n`;
    chain = chain
      .then(async () => {
        const size = await stat(file).then((s) => s.size, () => 0);
        if (size > MAX_FILE_BYTES) await rename(file, `${file}.1`).catch(() => {});
        await appendFile(file, line);
      })
      .catch(() => {});
  };
  writeRecord = write;

  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();

  const memory = () => {
    const m = process.memoryUsage();
    const heap = getHeapStatistics();
    return {
      rss: round(m.rss),
      heapUsed: round(m.heapUsed),
      heapTotal: round(m.heapTotal),
      external: round(m.external),
      arrayBuffers: round(m.arrayBuffers),
      heapLimit: round(heap.heap_size_limit),
    };
  };

  let reloads: number[] = [];
  const onRenderGone = (_event: unknown, contents: WebContents, details: { reason: string; exitCode: number }) => {
    write({ kind: 'render-process-gone', reason: details.reason, exitCode: details.exitCode, url: contents.getURL(), main: memory() });
    // 会话和子代理都在主进程里接着跑，渲染进程没了只剩一个白窗口。重载就能接回去。
    if (details.reason === 'clean-exit') return;
    const now = Date.now();
    reloads = reloads.filter((at) => now - at < RELOAD_WINDOW_MS);
    if (reloads.length >= MAX_RELOADS) {
      write({ kind: 'reload-skipped', reason: 'too many crashes' });
      return;
    }
    reloads.push(now);
    setTimeout(() => {
      if (contents.isDestroyed()) return;
      contents.reload();
      write({ kind: 'renderer-reloaded' });
    }, RELOAD_DELAY_MS).unref();
  };
  const onChildGone = (_event: unknown, details: { type: string; reason: string; exitCode: number; name?: string }) => {
    write({ kind: 'child-process-gone', ...details, main: memory() });
  };
  const onUnresponsive = () => write({ kind: 'renderer-unresponsive', main: memory() });
  app.on('render-process-gone', onRenderGone);
  app.on('child-process-gone', onChildGone);
  const watched = new WeakSet<WebContents>();
  const watchWindows = () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (watched.has(window.webContents)) continue;
      watched.add(window.webContents);
      window.on('unresponsive', onUnresponsive);
    }
  };

  write({ kind: 'start', pid: process.pid, versions: { electron: process.versions.electron, node: process.versions.node }, main: memory() });

  let sampling = false;
  const timer = setInterval(() => {
    if (sampling) return;
    sampling = true;
    watchWindows();
    const lagStats = {
      maxMs: Math.round(lag.max / 1e6),
      p99Ms: Math.round(lag.percentile(99) / 1e6),
      meanMs: Math.round(lag.mean / 1e6),
    };
    lag.reset();
    const ipc = topIpc();
    ipcStats.clear();
    const events = Object.fromEntries(eventCounts);
    eventCounts.clear();
    const dropped = droppedSends;
    droppedSends = 0;
    const processes = app.getAppMetrics().map((p) => ({
      pid: p.pid,
      type: p.type,
      privateMB: Math.round((p.memory.privateBytes ?? 0) / 1024),
      workingSetMB: Math.round(p.memory.workingSetSize / 1024),
    }));
    void Promise.all(BrowserWindow.getAllWindows().map((w) => rendererHeap(w.webContents)))
      .then((rendererJsHeapMB) => {
        write({ kind: 'sample', main: memory(), lag: lagStats, processes, rendererJsHeapMB, events, droppedSends: dropped, ipc });
      })
      .finally(() => {
        sampling = false;
      });
  }, INTERVAL_MS);
  timer.unref();

  return () => {
    clearInterval(timer);
    lag.disable();
    app.off('render-process-gone', onRenderGone);
    app.off('child-process-gone', onChildGone);
  };
}
