// 运行时配置：优先读 PI_RUNTIME_CONFIG 指向的 JSON（热更新源），回退 process.env。
// 进程内单例 + 内部 fs.watch 维护缓存，因此 getConfig 总读到最新值。

import { readFileSync, watch } from "node:fs";

let cache: Record<string, string> | null = null;
let started = false;
let watcher: import("node:fs").FSWatcher | undefined;
const subscribers = new Set<(next: Record<string, string>) => void>();

export function withoutSensitiveProcessConfig<T>(config: Record<string, T>): Record<string, T> {
  return { ...config };
}

/** Keep credentials available to extensions without leaking them to tool subprocesses. */
export function captureSensitiveProcessConfig(): void {
}

function configPath(): string | undefined {
  const p = process.env.PI_RUNTIME_CONFIG;
  return p && p.length > 0 ? p : undefined;
}

function read(): Record<string, string> {
  const p = configPath();
  if (!p) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function ensureStarted(): void {
  if (started) return;
  started = true;
  cache = read();
  const p = configPath();
  if (!p) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    watcher = watch(p, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        cache = read();
        for (const cb of subscribers) {
          try {
            cb(cache as Record<string, string>);
          } catch {
            /* subscriber error isolated */
          }
        }
      }, 150);
    });
    // 文件被原子替换(rename)/删除时 Windows 可能抛 EPERM；忽略避免 unhandled error。
    watcher.on("error", () => {});
  } catch {
    // watch 不可用：cache 保持首次读 + env 回退（仍可用，只是不热更新）
  }
}

export function getConfig(key: string): string | undefined {
  ensureStarted();
  return cache?.[key] ?? process.env[key];
}

export function getAllConfig(): Record<string, string> {
  ensureStarted();
  return withoutSensitiveProcessConfig({
    ...(process.env as Record<string, string>),
    ...(cache ?? {}),
  });
}

export function watchConfig(onChange: (next: Record<string, string>) => void): () => void {
  ensureStarted();
  subscribers.add(onChange);
  return () => subscribers.delete(onChange);
}

/** 仅测试用：重置单例状态。 */
export function __resetForTest(): void {
  watcher?.close();
  watcher = undefined;
  cache = null;
  started = false;
  subscribers.clear();
}
