import { lstatSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { pathKey } from "./reclaim.js";

/**
 * 让沙箱账户对工作区里几个配置目录只读：`.pi/`、`.vscode/`、`.idea/`。
 *
 * 这几处是别的程序（Pi 自己、编辑器）会在沙箱之外读取并照着执行的：Pi 启动时从 `.pi/` 加载扩展。工作区对
 * PiSandbox 开放写入，这些目录也就能被沙箱里的命令改掉。
 *
 * 做法，对已经存在的目录依次执行三步（顺序不能变，也不能合并成一次调用）：
 * 1. `/setowner <真实用户> /T`：所有者自带改 ACL 的权利。沙箱里自己建出来的东西（`mkdir .vscode`）归 PiSandbox 所有，
 *    不先拿回所有权，它一条命令就能把权限加回来。
 * 2. `/inheritance:d`：继承来的授权变成显式副本。
 * 3. `/grant:r PiSandbox:(OI)(CI)(RX)`：把账户的 Modify 副本整个换成读和执行。`:r` 是原子替换，账户任何时候都不会
 *    处于“一点权限都没有”的状态（中途被杀也不会）。
 * 每一步都加 `/L`：名字在检查之后可能被换成 junction，`/L` 让 icacls 只动链接本身，不跟过去。
 *
 * 结果：没有写权限、没有 DELETE，改、追加、新建、删、改名都不行；工作区根授的是 Modify，不含 FILE_DELETE_CHILD，
 * 也没法靠父目录删掉或改走它们。读不受影响，用户之后往里加的东西继承 RX，沙箱读得到。
 *
 * 为什么不用显式拒绝（deny）：实测只要拒绝了 DELETE，这个账户连读这个文件都被拒（cmd、node、PowerShell 都是），
 * 而不拒 DELETE 又挡不住删除和改名。
 *
 * 刻意不做的：
 * - `.git`（`config`、`hooks`）：`.git` 里要能建锁文件，所以沙箱就能往里新建任意文件名，git 会因为某个新建的文件改去别处
 *   读配置和 hooks，保护 `.git/config` 绕得过去；堵上要往用户的 `.git` 里写文件。还有：沙箱里自己 `git init` 出来的
 *   仓库、`.git/modules`、`.git/worktrees`、`core.hooksPath` 指向的目录都在范围之外。宿主在工作区里自动跑 git 的地方
 *   需要自己加固，不能指望这里。
 * - 单个文件（`.git/config`、`.gitmodules`、`.mcp.json`）：用户的工具“写临时文件再改名”保存时会把保护换掉，而记录
 *   还说已保护。
 * - `.claude`：里面可能有整套 worktree，要遍历成千上万个文件。
 *
 * 局限：
 * - 只能保护已经存在的目录。不存在的 `.pi` 没法提前保护，沙箱可以抢先建出来；保护之前放进去的内容保护不了，只是
 *   之后改不动。Pi 自己会在工作区里建 `.pi`，大多数工作区第一次会话后就有了。
 * - 目录被删了重建是另一个目录，记录里带着目录的标识（NTFS 文件索引），标识变了就重新保护。
 * - 工作区根目录本身仍然能被改名。
 * - 保护之后没有撤销路径（回收、关沙箱都不恢复继承），之后父目录 ACL 的改动不再传到这些目录。
 */
export const PROTECT_VERSION = "PR3";
export const PROTECT_PREFIX = "protect:";
export const PROTECT_COOLDOWN_MS = 5 * 60 * 1000;

/** 工作区下面的相对路径。 */
const PROTECTED_DIRS = [".pi", ".vscode", ".idea"] as const;

export interface ProtectTarget {
  path: string;
  relative: string;
  /** NTFS 文件索引。目录被删了重建，这个值就变了。 */
  id: string;
}

export type ProtectFn = (username: string, targets: ProtectTarget[], signal?: AbortSignal) => Promise<void>;

export function protectedKey(workspaceKey: string): string {
  return `${PROTECT_PREFIX}${workspaceKey}`;
}

/** 一个目录要依次跑的 icacls 参数。`owner` 是真实用户。 */
export function protectSteps(target: string, username: string, owner: string): string[][] {
  const flags = ["/L", "/C", "/Q"];
  return [
    [target, "/setowner", owner, "/T", ...flags],
    [target, "/inheritance:d", ...flags],
    [target, "/grant:r", `${username}:(OI)(CI)(RX)`, ...flags],
  ];
}

function plainDirectory(path: string): BigIntStats | undefined {
  try {
    const stat = lstatSync(path, { bigint: true });
    return stat.isDirectory() && !stat.isSymbolicLink() ? stat : undefined;
  } catch {
    return undefined;
  }
}

/** 存在的、不是链接的配置目录。链接指向别处，在这里改 ACL 改的是链接目标。 */
export function protectedTargets(workspaceRoot: string): ProtectTarget[] {
  const found: ProtectTarget[] = [];
  for (const relative of PROTECTED_DIRS) {
    const path = join(workspaceRoot, relative);
    const stat = plainDirectory(path);
    if (stat) found.push({ path, relative, id: String(stat.ino) });
  }
  return found;
}

/** 保护做完之后，这个目录还是原来那个吗（没被换成链接，也没被删了重建）。 */
function defaultStillSame(target: ProtectTarget): boolean {
  const stat = plainDirectory(target.path);
  return stat !== undefined && String(stat.ino) === target.id;
}

function recorded(value: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!value?.startsWith(`${PROTECT_VERSION}:`)) return map;
  for (const entry of value.slice(PROTECT_VERSION.length + 1).split(",")) {
    const at = entry.lastIndexOf("@");
    if (at > 0) map.set(entry.slice(0, at), entry.slice(at + 1));
  }
  return map;
}

function serialise(done: Map<string, string>): string {
  return `${PROTECT_VERSION}:${[...done].map(([relative, id]) => `${relative}@${id}`).join(",")}`;
}

/** 失败的工作区什么时候可以再试：进程内，免得每条命令都重跑一遍超时的步骤。 */
const failedAt = new Map<string, number>();

export function __resetProtectFailuresForTest(): void {
  failedAt.clear();
}

export interface ProtectOptions {
  /** 测试用：不去读磁盘。 */
  targets?: ProtectTarget[];
  stillSame?: (target: ProtectTarget) => boolean;
  now?: () => number;
  signal?: AbortSignal;
}

/**
 * 给工作区里现存的、还没保护过（或已经不是原来那个）的配置目录加保护，逐个做、做成一个记一个。
 * 失败（不是 abort）后停下，冷却期内不再试；已经做成的保留。返回 grants 是否有变化。
 */
export async function applyWorkspaceProtection(
  username: string,
  workspaceRoot: string,
  grants: Record<string, string>,
  protect: ProtectFn,
  options: ProtectOptions = {},
): Promise<boolean> {
  const targets = options.targets ?? protectedTargets(workspaceRoot);
  const key = protectedKey(pathKey(workspaceRoot));
  const done = recorded(grants[key]);
  const todo = targets.filter((target) => done.get(target.relative) !== target.id);
  if (todo.length === 0) return false;
  const now = (options.now ?? Date.now)();
  const last = failedAt.get(key);
  if (last !== undefined && now - last < PROTECT_COOLDOWN_MS) return false;
  const stillSame = options.stillSame ?? defaultStillSame;

  let changed = false;
  for (const target of todo) {
    try {
      await protect(username, [target], options.signal);
    } catch (error) {
      if (error instanceof Error && error.message === "aborted") throw error;
      failedAt.set(key, now);
      break;
    }
    if (!stillSame(target)) continue;
    done.set(target.relative, target.id);
    grants[key] = serialise(done);
    changed = true;
  }
  return changed;
}
