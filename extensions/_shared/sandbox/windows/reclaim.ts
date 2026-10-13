import { resolve } from "node:path";

/**
 * 回收 grants.json 里不再用的授权。
 *
 * 工作区和每个会话的临时目录都被永久授了 PiSandbox 的修改权，用得越久，沙箱账户能写的目录越多，
 * 任何一次沙箱命令都能写进以前用过的所有工作区。受限令牌挡不住这一条：授权是直接给账户的。
 * 这里按“多久没用过”回收：
 * - 路径已经不存在：只丢记录（ACE 随目录一起没了）。
 * - 修改权闲置超过 GRANT_MAX_IDLE_MS：`icacls /remove:g` 撤掉，丢记录。再用到时按原有流程重新授权。
 * 不在一次命令里等撤销做完：大目录树的撤销和授权一样慢（3 万个文件 30–47 秒），撤销由 io 在后台起一个
 * 独立进程去做，记录先丢。撤销没做完的最坏结果是残留一条 ACE，下次用到这个目录时记录缺失，会再授一次。
 *
 * 撤销带 /T，会摘掉整棵树上的 ACE，所以：
 * - 闲置的目录如果是某个在用目录（或近期用过的目录）的祖先，不撤销，否则在用目录的授权也被摘掉、记录却还在。
 * - 撤销一个目录时，它下面的所有记录（任何权限）一起丢，让它们下次用到时重新授权。
 */
export const GRANT_MAX_IDLE_MS = 14 * 24 * 60 * 60 * 1000;
/** 在用的目录，上次使用时间超过这么久才重写一次，免得每条命令都写 grants.json。 */
export const USED_REFRESH_MS = 60 * 60 * 1000;
/** 一次最多撤销几个，积压很多时不要一下起一堆 icacls。 */
export const MAX_REVOKES_PER_RUN = 3;

const USED_PREFIX = "used:";
const AMBIENT_PREFIX = "ambient:";
/** protect.ts 的记录：`protect:<工作区键>`，值是已保护的路径集合。和工作区同生同灭。 */
const PROTECT_PREFIX = "protect:";
const MODIFY = "M";

/** 与 account.ts 的 grantKey 同一个公式（那边导出，这里不能反过来引用，会循环依赖；测试里核对两者一致）。 */
export function pathKey(target: string): string {
  return resolve(target).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function usedKey(key: string): string {
  return `${USED_PREFIX}${key}`;
}

/** 只撤销账户名下的授权 ACE，拒绝类 ACE 留着。 */
export function revokeArgs(target: string, username: string): string[] {
  return [target, "/remove:g", username, "/T", "/C", "/Q"];
}

export interface ReclaimOptions {
  now: number;
  /** 正在用的工作区和临时目录：永不回收，并刷新它们的使用时间。 */
  keep: string[];
  exists: (path: string) => boolean;
  /** 发起撤销，不等它做完。 */
  revoke: (path: string) => void;
  /** 是否检查“目录已不存在”：每条记录一次文件系统调用，调用方限频。默认检查。 */
  prune?: boolean;
  /** 真实路径（解开 junction、subst）；比较在用目录时两种写法都算。失败时返回原路径。 */
  real?: (path: string) => string;
}

function isRecordOfADirectory(key: string): boolean {
  return !key.startsWith(USED_PREFIX) && !key.startsWith(AMBIENT_PREFIX) && !key.startsWith(PROTECT_PREFIX);
}

const DRIVE_PATH = /^[a-z]:\/.+/;

/** 盘根不动：要有至少一级目录。 */
function isBelowDriveRoot(key: string): boolean {
  return DRIVE_PATH.test(key);
}

function lastUsed(grants: Record<string, string>, key: string): number | undefined {
  const value = Number(grants[usedKey(key)]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** `inner` 就是 `outer`，或者在它下面（按路径段，`c:/work-old` 不在 `c:/work` 下面）。 */
export function atOrUnder(inner: string, outer: string): boolean {
  return inner === outer || inner.startsWith(`${outer}/`);
}

/** 就地改 `grants`；有变化返回 true。 */
export function reclaimGrants(grants: Record<string, string>, options: ReclaimOptions): boolean {
  const real = (path: string): string => {
    try {
      return pathKey(options.real?.(path) ?? path);
    } catch {
      return pathKey(path);
    }
  };
  let changed = false;
  const keep = new Set(options.keep.flatMap((path) => [pathKey(path), real(path)]));

  if (options.prune ?? true) {
    for (const record of Object.keys(grants)) {
      const protectsWorkspace = record.startsWith(PROTECT_PREFIX);
      const key = protectsWorkspace ? record.slice(PROTECT_PREFIX.length) : record;
      if (!(protectsWorkspace || isRecordOfADirectory(record)) || keep.has(key)) continue;
      // 只对盘符路径判断：盘还在、目录不在才丢。盘不可用（拔掉的 U 盘、断开的映射盘）不当作目录被删；
      // UNC 没有盘可问，也不动。
      if (!DRIVE_PATH.test(key) || !options.exists(`${key.slice(0, 2)}/`)) continue;
      if (options.exists(key)) continue;
      delete grants[record];
      delete grants[usedKey(key)];
      changed = true;
    }
  }

  for (const key of keep) {
    const seen = lastUsed(grants, key);
    if (seen !== undefined && options.now - seen < USED_REFRESH_MS) continue;
    grants[usedKey(key)] = String(options.now);
    changed = true;
  }

  // 近期用过的目录和在用的目录一样，不能被它的祖先的撤销连带摘掉。
  const inUse = new Set(keep);
  for (const key of Object.keys(grants)) {
    if (!isRecordOfADirectory(key)) continue;
    const seen = lastUsed(grants, key);
    if (seen !== undefined && options.now - seen <= GRANT_MAX_IDLE_MS) inUse.add(key);
  }
  const shelters = (key: string): boolean => {
    const candidates = [key, real(key)];
    return [...inUse].some((used) => candidates.some((candidate) => atOrUnder(used, candidate)));
  };

  const idle: Array<{ key: string; seen: number }> = [];
  for (const [key, rights] of Object.entries(grants)) {
    if (!isRecordOfADirectory(key) || rights !== MODIFY || keep.has(key) || !isBelowDriveRoot(key)) continue;
    const seen = lastUsed(grants, key);
    if (seen === undefined) {
      // 升级前授的权没有使用时间：从现在起算，不一上来就撤销。
      grants[usedKey(key)] = String(options.now);
      changed = true;
    } else if (options.now - seen > GRANT_MAX_IDLE_MS && !shelters(key)) {
      idle.push({ key, seen });
    }
  }

  idle.sort((a, b) => a.seen - b.seen);
  for (const { key } of idle.slice(0, MAX_REVOKES_PER_RUN)) {
    options.revoke(key);
    delete grants[`${PROTECT_PREFIX}${key}`];
    for (const other of Object.keys(grants)) {
      if (atOrUnder(other.startsWith(USED_PREFIX) ? other.slice(USED_PREFIX.length) : other, key)
        && (isRecordOfADirectory(other) || other.startsWith(USED_PREFIX))) {
        delete grants[other];
      }
    }
    changed = true;
  }
  return changed;
}

/**
 * 把这一次调用对 grants 做的增删，合并到磁盘上现在的内容里再写。
 * 不加锁的情况下，整体覆盖写会把别的进程刚做的删除（撤销后丢掉的记录）又写回去：ACE 没了，记录说还在，
 * 之后永远不会重新授权。合并之后最多多留一个孤立的使用时间戳。
 */
export function mergeGrantChanges(
  before: Record<string, string>,
  after: Record<string, string>,
  onDisk: Record<string, string>,
): Record<string, string> {
  const merged = { ...onDisk };
  for (const [key, value] of Object.entries(after)) {
    if (before[key] !== value) merged[key] = value;
  }
  for (const key of Object.keys(before)) {
    if (!(key in after)) delete merged[key];
  }
  return merged;
}
