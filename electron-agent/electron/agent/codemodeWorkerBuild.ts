import { posix } from 'node:path';

/**
 * 生产主进程把 @earendil-works/pi-codemode 打进 chunk（externalizeDeps: false）。
 * 它的 runtime/host.js 默认用 `new URL("./worker.js", import.meta.url)` 起 worker 线程，
 * 打包后这个相对路径落在 host 所在 chunk 的同一目录。构建要在那里放一个 worker 入口。
 */
export const CODEMODE_WORKER_ENTRY = 'chunks/worker';

/** pi 官方给打包版准备的 worker 入口（只 import "@earendil-works/pi-codemode/worker"）。 */
export const CODEMODE_WORKER_SOURCE = 'node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/worker.js';

const HOST_MODULE = /[\\/]pi-codemode[\\/]dist[\\/]runtime[\\/]host\.js$/;

export interface BuiltChunk { fileName: string; isEntry: boolean; moduleIds: readonly string[] }

/** host.js 所在 chunk 的同目录没有 worker.js 入口时返回错误说明；没打包 codemode 时返回 undefined。 */
export function codemodeWorkerMismatch(chunks: readonly BuiltChunk[]): string | undefined {
  const host = chunks.find((chunk) => chunk.moduleIds.some((id) => HOST_MODULE.test(id)));
  if (!host) return undefined;
  const expected = posix.join(posix.dirname(host.fileName.replace(/\\/g, '/')), 'worker.js');
  if (chunks.some((chunk) => chunk.isEntry && chunk.fileName.replace(/\\/g, '/') === expected)) return undefined;
  return `pi-codemode 的 host 在 ${host.fileName}，运行时会找 ${expected}，但构建没有产出这个入口；codemode 将无法启动 worker。`;
}
