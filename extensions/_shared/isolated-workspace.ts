// 独立工作区（A 轨）的身份与写闸判定，主进程（IsolatedWorkspaceService 建、列）与 agent-host（safety、sandbox）共用。
// Note: 见 .agents/notes/implemented/architecture/2026-10-17-grenagent-hosted-worktree-dual-track.md
//
// 独立工作区是宿主在 <主仓>/.gren/worktrees/<id>/ 克隆出来、作为独立 workspace 打开的目录。身份只认两样，
// 都是模型在 W 里改不到的：W 的规范路径形如 <P>/.gren/worktrees/<id>，以及主仓里和 W 平级的 marker
// <P>/.gren/worktrees/<id>.json。不读 W 里的任何文件——W 是可写根，那里的东西模型都能改。

import { existsSync, readFileSync, realpathSync, lstatSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const ISOLATED_POOL = join(".gren", "worktrees");
export const ISOLATED_MARKER_VERSION = 1;
export const ISOLATED_BRANCH_PREFIX = "gren/";

export type IsolatedBaseKind = "fresh" | "head";

export interface IsolatedWorkspaceMarker {
  version: typeof ISOLATED_MARKER_VERSION;
  id: string;
  /** W 的规范路径。 */
  path: string;
  /** 主仓根的规范路径。 */
  parentRoot: string;
  branch: string;
  base: { kind: IsolatedBaseKind; ref: string; commit: string };
  createdAt: string;
  createdBy: "grenagent";
  /** 创建时从主仓带进来的未提交改动（复制，主仓不动）。没带时不写。 */
  carried?: { tracked: boolean; untracked: number };
}

/** id 只用小写字母、数字和连字符：它同时是目录名、marker 文件名和分支名的一段。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidIsolatedId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export function isolatedPoolOf(parentRoot: string): string {
  return join(parentRoot, ISOLATED_POOL);
}

export function isolatedMarkerPath(parentRoot: string, id: string): string {
  return join(isolatedPoolOf(parentRoot), `${id}.json`);
}

function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

function samePath(a: string, b: string): boolean {
  return fold(resolve(a).replace(/[\\/]+$/, "")) === fold(resolve(b).replace(/[\\/]+$/, ""));
}

/** a 在 root 里（含 root 本身）。两边都应已是规范路径。 */
function inside(path: string, root: string): boolean {
  const rel = relative(fold(root), fold(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * 把一个可能还不存在的路径解析成真实位置：最近一个存在的祖先取 realpath（跟随 junction / 符号链接），
 * 再接上剩下的段。写工具会跟着链接写，判断越界必须看链接指向哪里。
 */
export function resolveRealTarget(path: string): string {
  let current = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      lstatSync(current);
      break;
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      rest.unshift(basename(current));
      current = parent;
    }
  }
  return rest.length ? join(canonical(current), ...rest) : canonical(current);
}

/** 校验 marker 字段；不合格返回 undefined。 */
export function parseIsolatedMarker(raw: unknown): IsolatedWorkspaceMarker | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const m = raw as Record<string, unknown>;
  const base = m.base as Record<string, unknown> | undefined;
  if (m.version !== ISOLATED_MARKER_VERSION || m.createdBy !== "grenagent") return undefined;
  if (typeof m.id !== "string" || !isValidIsolatedId(m.id)) return undefined;
  for (const key of ["path", "parentRoot", "branch", "createdAt"] as const) {
    if (typeof m[key] !== "string" || !(m[key] as string)) return undefined;
  }
  if (!base || (base.kind !== "fresh" && base.kind !== "head")) return undefined;
  if (typeof base.ref !== "string" || typeof base.commit !== "string" || !base.commit) return undefined;
  return raw as IsolatedWorkspaceMarker;
}

/** 读 marker 并核对它说的就是 <parentRoot>/.gren/worktrees/<id>。 */
export function readIsolatedMarker(parentRoot: string, id: string): IsolatedWorkspaceMarker | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(isolatedMarkerPath(parentRoot, id), "utf8"));
  } catch {
    return undefined;
  }
  const marker = parseIsolatedMarker(parsed);
  if (!marker || marker.id !== id) return undefined;
  if (!samePath(marker.parentRoot, parentRoot)) return undefined;
  if (!samePath(marker.path, join(isolatedPoolOf(parentRoot), id))) return undefined;
  return marker;
}

/**
 * 只按路径字符串判断是不是 <P>/.gren/worktrees/<id> 的形状（不读盘，目录不存在也能判）。
 * 渲染层给侧栏分组、主进程判断「独立工作区已删除」都用它；是不是真的托管还要看 marker。
 */
export function isolatedPathParts(path: string): { parentRoot: string; id: string } | undefined {
  const root = resolve(path).replace(/[\\/]+$/, "");
  const id = basename(root);
  const pool = dirname(root);
  const gren = dirname(pool);
  if (fold(basename(pool)) !== "worktrees" || fold(basename(gren)) !== ".gren") return undefined;
  if (!isValidIsolatedId(id)) return undefined;
  const parentRoot = dirname(gren);
  if (parentRoot === gren) return undefined;
  return { parentRoot, id };
}

/**
 * 已确认的独立工作区按规范路径缓存。marker 建好后不改，但会被删除（删独立工作区先删 marker）：
 * 命中缓存时确认 marker 文件还在，不在就作废。没确认的不缓存（可能是正在建）。
 */
const confirmed = new Map<string, IsolatedWorkspaceMarker>();

/**
 * workspace 是不是独立工作区；是就返回 marker（其中 path / parentRoot 换成本机规范路径）。
 * workspace 应是会话的原始目录（projectCwd），不是 working_directory 切过去的当前目录。
 */
export function isolatedWorkspaceOf(workspace: string | undefined): IsolatedWorkspaceMarker | undefined {
  if (!workspace) return undefined;
  const root = canonical(workspace);
  const key = fold(root);
  const cached = confirmed.get(key);
  if (cached) {
    if (existsSync(isolatedMarkerPath(cached.parentRoot, cached.id))) return cached;
    confirmed.delete(key);
  }
  const parts = isolatedPathParts(root);
  if (!parts) return undefined;
  const { parentRoot, id } = parts;
  const marker = readIsolatedMarker(parentRoot, id);
  if (!marker) return undefined;
  const resolved = { ...marker, path: root, parentRoot: canonical(parentRoot) };
  confirmed.set(key, resolved);
  return resolved;
}

/** 独立工作区里写 target 会不会落进主仓：在主仓根内、又不在 W 内（跟随链接后判断）。 */
export function writesIntoParent(marker: Pick<IsolatedWorkspaceMarker, "path" | "parentRoot">, target: string): boolean {
  const real = resolveRealTarget(target);
  return inside(real, marker.parentRoot) && !inside(real, marker.path);
}

/** 给模型和用户的一句话拒绝理由。 */
export function parentWriteRefusal(marker: Pick<IsolatedWorkspaceMarker, "parentRoot">, target: string): string {
  return `独立工作区不能写主仓（${marker.parentRoot}）：${target}。只改当前工作区里的文件；需要回到主仓时由宿主回传分支`;
}

export const FULL_ACCESS_REFUSAL = "独立工作区不能升权到 danger-full-access：沙箱只放行当前工作区";

export function __resetIsolatedWorkspaceCacheForTest(): void {
  confirmed.clear();
}
