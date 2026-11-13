import { join } from 'node:path';

interface EntryInput { packaged: boolean; resourcesPath: string; mainDir: string }

/** RunAsNode 子进程的入口脚本都在 out/main 下；打包后从 app.asar.unpacked 加载。 */
function resolveMainScript(name: string, input: EntryInput): string {
  return input.packaged
    ? join(input.resourcesPath, 'app.asar.unpacked', 'out', 'main', name)
    : join(input.mainDir, name);
}

export function resolveWorkerEntry(input: EntryInput): string {
  return resolveMainScript('pi-worker.js', input);
}

/** agent-host 子进程：交互运行时所在的进程。 */
export function resolveAgentHostEntry(input: EntryInput): string {
  return resolveMainScript('agent-host.js', input);
}

/** agentdata-host 子进程：AgentData 运行时（agent-data.db 的唯一持有者）。 */
export function resolveAgentDataHostEntry(input: EntryInput): string {
  return resolveMainScript('agentdata-host.js', input);
}

/** codegraph-host 子进程：CodeGraph SDK 的索引与查询都在这里跑，不占主线程。 */
export function resolveCodeGraphHostEntry(input: EntryInput): string {
  return resolveMainScript('codegraph-host.js', input);
}

/** codegraph-host 里的 SDK 工作线程（一个写线程、若干读线程共用这个入口）。 */
export function resolveCodeGraphWorkerEntry(input: EntryInput): string {
  return resolveMainScript('codegraph-worker.js', input);
}

/** agent-host 的进程树守卫（Windows）。构建时由 copyPiAdjacentAssets 拷到 out/main。 */
export function resolveJobGuardExe(input: EntryInput): string {
  return resolveMainScript('pi-job-guard.exe', input);
}
