// create_worktree 的 git 部分，照 DSH packages/experimental/worktree：
// 从当前目录找仓库根，先把起点钉成一个提交，再在 <仓库根>/.agents/worktrees/<分支名> 下建新分支和 checkout。
// 只有这次创建了 worktrees 目录才写自忽略的 .gitignore（`*`）。git 不走 shell，关掉 hooks / fsmonitor /
// 按需拉取 / filter，清掉会把命令指向别处的 GIT_* 环境变量。不额外授权：目标目录和共享的 git 元数据目录
// 都必须本来就在会话可写根里且可写，否则直接报出是哪个目录。分配之后的失败保留已经建出的东西。

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const WORKTREE_POOL = join(".agents", "worktrees");
export const WORKTREE_NAME_PREFIX = "worktree-";
const GIT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface CreateWorktreeInput {
  /** 调用方会话的当前目录：从这里找仓库。 */
  cwd: string;
  /** 会话的可写根（原始工作区）：目标目录和 git 元数据目录都必须在它下面。 */
  writableRoot: string;
  name?: string;
  from?: string;
  signal?: AbortSignal;
}

export interface CreatedWorktree {
  path: string;
  branch: string;
  baseCommit: string;
  repositoryRoot: string;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 会把 git 指向别的仓库、索引或配置的环境变量（DSH process.ts 的清单）。 */
const SCRUBBED_GIT_ENV =
  /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|PREFIX|REPLACE_REF_BASE|ATTR_SOURCE|CONFIG|CONFIG_.+)$/;

function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!SCRUBBED_GIT_ENV.test(key)) env[key] = value;
  }
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1", ...extra };
}

function gitPrefix(): string[] {
  const nullHooks = process.platform === "win32" ? "NUL" : "/dev/null";
  return ["--no-lazy-fetch", "-c", `core.hooksPath=${nullHooks}`, "-c", "core.fsmonitor=false", "-c", "core.longpaths=true"];
}

function runGit(
  cwd: string,
  args: string[],
  opts: { allowCodes?: readonly number[]; env?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error("create_worktree was cancelled"));
      return;
    }
    const child = spawn("git", [...gitPrefix(), ...args], {
      cwd,
      env: gitEnv(opts.env),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    const take = (current: string, chunk: Buffer): string => {
      if (current.length + chunk.length > MAX_OUTPUT_BYTES) {
        overflow = true;
        return current;
      }
      return current + chunk.toString("utf8");
    };
    child.stdout?.on("data", (d: Buffer) => (stdout = take(stdout, d)));
    child.stderr?.on("data", (d: Buffer) => (stderr = take(stderr, d)));
    const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS);
    const onAbort = () => child.kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (e) => {
      done();
      reject(new Error(`worktree command failed: ${e.message}`));
    });
    child.on("close", (code) => {
      done();
      if (opts.signal?.aborted) return reject(new Error("create_worktree was cancelled"));
      if (overflow) return reject(new Error("worktree command output exceeds the limit"));
      const exit = code ?? -1;
      if (!(opts.allowCodes ?? [0]).includes(exit)) {
        return reject(new Error(`worktree command failed (${exit}): ${(stderr || stdout).trim()}`));
      }
      resolvePromise({ code: exit, stdout, stderr });
    });
  });
}

/** DSH relativePath()：相对的分支名，不能有反斜杠、冒号、空段、. / .. 段，不能以 - 开头。 */
export function validateWorktreeName(name: string): void {
  const segments = name.split("/");
  const bad =
    name.includes("\\") ||
    name.includes(":") ||
    name.startsWith("-") ||
    segments.some((s) => s === "" || s === "." || s === "..");
  if (bad) throw new Error("worktree name must be a relative Git branch name");
}

function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

export function isInside(path: string, root: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? canonical(p).toLowerCase() : canonical(p));
  const rel = relative(norm(root), norm(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function nearestExisting(path: string): string {
  let current = resolve(path);
  for (;;) {
    try {
      lstatSync(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

function assertWritable(path: string, writableRoot: string, what: string): void {
  if (!isInside(nearestExisting(path), writableRoot)) {
    throw new Error(`${what} is outside this session's writable workspace (${writableRoot}): "${path}"`);
  }
  try {
    accessSync(nearestExisting(path), constants.W_OK);
  } catch {
    throw new Error(`${what} is not writable: "${path}"`);
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** 独占建目录：已存在返回 false。 */
function claimDirectory(path: string): boolean {
  try {
    mkdirSync(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

/** 列出 dest 里配置的 filter 驱动，生成把它们全部置空的 GIT_CONFIG_* 环境（不写 git 配置）。 */
async function disabledFilterEnv(dest: string, signal?: AbortSignal): Promise<Record<string, string>> {
  const r = await runGit(dest, ["config", "--null", "--name-only", "--get-regexp", "^filter\\."], {
    allowCodes: [0, 1],
    ...(signal ? { signal } : {}),
  });
  const drivers = new Set<string>();
  for (const key of r.stdout.split("\0")) {
    const m = /^filter\.(.+)\.[^.]+$/.exec(key.trim());
    if (m?.[1]) drivers.add(m[1]);
  }
  const pairs: Array<[string, string]> = [];
  for (const d of drivers) {
    for (const k of ["clean", "smudge", "process"]) pairs.push([`filter.${d}.${k}`, ""]);
    pairs.push([`filter.${d}.required`, "false"]);
  }
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

export async function createWorktree(input: CreateWorktreeInput): Promise<CreatedWorktree> {
  const { cwd, signal } = input;
  const sig = signal ? { signal } : {};
  if (input.name !== undefined) validateWorktreeName(input.name);
  if (input.from !== undefined && !input.from.trim()) {
    throw new Error("worktree from must name a local commit, branch, or tag");
  }
  const branch = input.name ?? `${WORKTREE_NAME_PREFIX}${randomUUID().slice(0, 8)}`;
  await runGit(cwd, ["check-ref-format", `refs/heads/${branch}`], sig);
  const repositoryRoot = canonical((await runGit(cwd, ["rev-parse", "--show-toplevel"], sig)).stdout.trim());
  const baseCommit = (
    await runGit(cwd, ["rev-parse", "--verify", "--end-of-options", `${input.from?.trim() || "HEAD"}^{commit}`], sig)
  ).stdout.trim();
  const branchExists = await runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    allowCodes: [0, 1],
    ...sig,
  });
  if (branchExists.code === 0) throw new Error(`worktree branch already exists: ${branch}`);

  const pool = join(repositoryRoot, WORKTREE_POOL);
  const dest = join(pool, ...branch.split("/"));
  if (exists(dest)) throw new Error(`worktree path already exists: ${dest}`);
  const commonDir = resolve(cwd, (await runGit(cwd, ["rev-parse", "--git-common-dir"], sig)).stdout.trim());
  assertWritable(pool, input.writableRoot, "worktree directory");
  assertWritable(commonDir, input.writableRoot, "Git metadata directory");

  mkdirSync(dirname(pool), { recursive: true });
  if (claimDirectory(pool)) writeFileSync(join(pool, ".gitignore"), "*\n", { flag: "wx" });
  mkdirSync(dirname(dest), { recursive: true });
  if (!claimDirectory(dest)) throw new Error(`worktree path already exists: ${dest}`);

  try {
    await runGit(cwd, ["--work-tree", repositoryRoot, "worktree", "add", "--no-checkout", "-b", branch, "--", dest, baseCommit], sig);
    const filterEnv = await disabledFilterEnv(dest, signal);
    await runGit(dest, ["--work-tree", dest, "reset", "--hard", "--no-recurse-submodules", baseCommit], {
      env: filterEnv,
      ...sig,
    });
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    throw new Error(`Could not finish worktree ${branch} at ${dest}. Any created checkout and branch are retained. ${message}`);
  }
  return { path: canonical(dest), branch, baseCommit, repositoryRoot };
}
