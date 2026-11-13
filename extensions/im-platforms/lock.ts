// 跨进程单实例锁：用一个 lock 文件（内含持有者 pid）保证某资源只被一个进程持有。
//
// 背景：多个 Pi 进程手动加载微信扩展，若都用同一 bot token 长轮询
// getupdates，同一条消息会被多个实例各自收到并回复（"发给所有会话"）。用本锁保证只有一个
// 持锁进程连接微信；持有者退出后由其它进程接管。
//
// 心跳：仅靠 pid 探活在「持有者崩溃后 pid 被系统复用给无关进程」时会误判为存活，陈旧锁永不
// 清除、故障转移失效。持有者用 refreshLock 定期刷新锁文件 mtime 当心跳；acquireLock 发现 mtime
// 超过 LOCK_STALE_MS（远大于刷新间隔）即视为陈旧并接管，即便 pid「看似存活」。

import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// 锁过期阈值：持有者超过这么久没刷新心跳即视为陈旧。须远大于持有者的刷新间隔（见 index.ts 的
// lockHeartbeat，默认 20s），留足容差避免误抢活锁。
const LOCK_STALE_MS = 60_000;

/** 进程是否存活：kill(pid,0) 不发信号、仅探测存在；EPERM＝存在但无权限（视为存活）。 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 尝试获取锁。返回 true＝本进程持有（可安全使用资源）。
 * - 用 'wx' 排他创建：多进程同时抢时只有一个成功（原子）。
 * - 已存在但持有者已死（陈旧锁）→ 清除后重抢一次。
 * - 已存在且持有者存活 → 返回 false（别的进程持有）。
 */
/** 锁是否陈旧：持有者超过 LOCK_STALE_MS 没刷新心跳（mtime）。读不到 mtime 也按陈旧处理。 */
function isLockStale(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
  } catch {
    return true;
  }
}

export function acquireLock(lockPath: string, pid = process.pid): boolean {
  const me = String(pid);
  for (let i = 0; i < 2; i += 1) {
    try {
      mkdirSync(dirname(lockPath), { recursive: true });
      writeFileSync(lockPath, me, { flag: "wx" });
      return true;
    } catch {
      let owner: number;
      try {
        owner = Number(readFileSync(lockPath, "utf8").trim());
      } catch {
        return false; // 读不到（竞态被删）→ 交给下一轮重试
      }
      if (owner === pid) {
        refreshLock(lockPath, pid); // 本进程已持有 → 顺便续一次心跳
        return true;
      }
      // 别的活进程持有「且」心跳新鲜 → 抢不到。心跳过期（持有者挂了 / pid 被复用）→ 当陈旧处理。
      if (pidAlive(owner) && !isLockStale(lockPath)) return false;
      try {
        rmSync(lockPath, { force: true }); // 陈旧锁（持有者已死 / 心跳停摆）→ 清除后重抢
      } catch {
        return false;
      }
    }
  }
  return false;
}

/** 心跳：持有者定期调用，刷新锁文件 mtime，向其它进程表明自己仍存活（防 pid 复用误判）。 */
export function refreshLock(lockPath: string, pid = process.pid): void {
  try {
    if (readFileSync(lockPath, "utf8").trim() !== String(pid)) return; // 非本进程持有 → 不动
    const now = new Date();
    utimesSync(lockPath, now, now);
  } catch {
    /* 锁已不存在 / 未持有 */
  }
}

/** 释放锁：仅当本进程是持有者时才删除，避免误删别的进程刚抢到的锁。 */
export function releaseLock(lockPath: string, pid = process.pid): void {
  try {
    if (readFileSync(lockPath, "utf8").trim() === String(pid)) rmSync(lockPath, { force: true });
  } catch {
    /* 未持有 / 已不存在 */
  }
}
