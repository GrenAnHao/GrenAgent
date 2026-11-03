/**
 * codegraph-host 的资源上限。解析线程数用 SDK 认的 CODEGRAPH_PARSE_WORKERS；
 * `--liftoff-only` 用 v8.setFlagsFromString 打在当前 isolate 上。字节码入口不能把这个参数放进进程 argv，
 * SDK 自己再拉起的解析线程是另一个 isolate，不一定带上这个旗标；超了 RSS 由调用方退出进程。
 */
import { availableParallelism, constants, setPriority as setOsPriority } from 'node:os';
import { setFlagsFromString } from 'node:v8';

export function defaultParseWorkers(cores: number): number {
  return Math.min(2, Math.max(1, Math.floor(cores / 4)));
}

/** 0 表示关掉 RSS 守卫。非法值退回默认 3072 MB。 */
export function rssLimitBytes(envValue: string | undefined, fallbackMb = 3072): number {
  if (envValue === undefined || envValue.trim() === '') return fallbackMb * 1_048_576;
  const mb = Number(envValue);
  if (!Number.isFinite(mb) || mb < 0) return fallbackMb * 1_048_576;
  return Math.floor(mb * 1_048_576);
}

export function applyHostLimits(options: {
  env?: NodeJS.ProcessEnv;
  cores?: number;
  pid?: number;
  setPriority?: (pid: number, priority: number) => void;
  setFlags?: (flags: string) => void;
} = {}): void {
  const env = options.env ?? process.env;
  const cores = options.cores ?? availableParallelism();
  if (!env.CODEGRAPH_PARSE_WORKERS?.trim()) env.CODEGRAPH_PARSE_WORKERS = String(defaultParseWorkers(cores));
  try { (options.setPriority ?? setOsPriority)(options.pid ?? process.pid, constants.priority.PRIORITY_BELOW_NORMAL); }
  catch { /* 没有权限改优先级时照常跑 */ }
  const setFlags = options.setFlags ?? setFlagsFromString;
  for (const flag of ['--liftoff-only', '--max-old-space-size=2048']) {
    try { setFlags(flag); } catch { /* 旗标被拒绝或进程已经锁死，RSS 守卫兜底 */ }
  }
}
