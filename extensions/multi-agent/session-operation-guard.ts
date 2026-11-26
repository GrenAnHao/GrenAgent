// 迁移与普通会话写入口的共享排他点（扩展侧唯一注入处）。
//
// 迁移事务、删除、发送、外部唤醒子代理都要对同一份会话族取同一把 lease。lease 的单位是
// 规范物理路径，实现在宿主（electron/app/sessionOperationLease.ts）；扩展不能直接 import 宿主模块：
//   - 扩展可能跑在 worker / CLI 进程里，没有 Electron 的 agentDir；
//   - 宿主也需要能在 agent-host 启动时安装具体实现。
//
// 宿主在 `session_start` / runtimeGraph 构造时调用 `installSessionOperationGuard`，传进来一个
// 已经绑定 agentDir 的 `withSessionOperationLease`。没装时是透传：CLI、测试和旧宿主行为不变。
//
// 还有两个查询面：
//   - `installSessionOperationReadGate`：异步问「这些路径 / 工作区被未完成迁移阻塞了吗」，
//     宿主用迁移 owner 的 `blocked()` 接；用于冷恢复、外部唤醒前的检查。
//   - `installSessionOperationBlockedSnapshot`：同步的阻塞路径快照，宿主要在 journal 阶段变化时刷新。
//     列表 / 历史这类同步读接口用它把半迁移族藏起来，同项目其他会话不受影响。
//
// 约定：guard 必须支持异步上下文重入。宿主用 AsyncLocalStorage 实现；嵌套调用（外部唤醒 →
// 冷恢复 → JSONL 追加）复用同一把锁，不会自己等自己。

import { resolve } from "node:path";

export type SessionOperationGuard = <T>(paths: readonly string[], operation: () => Promise<T>) => Promise<T>;

/** 与宿主 lease coordinator 的 blocker 形状一致（多一层 familyPaths 便于一次拿整族锁）。 */
export interface SessionOperationBlocker {
  path?: string;
  familyPaths?: string[];
  reason: string;
  operationId?: string;
}

/**
 * 只读闸门：问「这些路径 / 工作区现在被未完成迁移阻塞了吗」。宿主用
 * `SessionProjectTransferOwner.blocked(query)` 注入；没有注入就不阻塞。
 * 任何查询失败都必须由宿主按 fail-closed 处理（这里只透传）。
 */
export type SessionOperationReadGate = (query: {
  paths?: readonly string[];
  workspaces?: readonly string[];
}) => Promise<readonly SessionOperationBlocker[]>;

/** 同步阻塞路径来源：返回当前未完成迁移族的会话路径。 */
export type SessionOperationBlockedSnapshot = () => readonly string[];

let installed: SessionOperationGuard | undefined;
let readGate: SessionOperationReadGate | undefined;
let blockedSnapshot: SessionOperationBlockedSnapshot | undefined;

export function installSessionOperationGuard(guard: SessionOperationGuard | undefined): void {
  installed = guard;
}

export function installedSessionOperationGuard(): SessionOperationGuard | undefined {
  return installed;
}

export function installSessionOperationReadGate(gate: SessionOperationReadGate | undefined): void {
  readGate = gate;
}

export function installedSessionOperationReadGate(): SessionOperationReadGate | undefined {
  return readGate;
}

export function installSessionOperationBlockedSnapshot(snapshot: SessionOperationBlockedSnapshot | undefined): void {
  blockedSnapshot = snapshot;
}

/**
 * 同步规范化：只做 resolve、分隔符、大小写与尾斜杠，不做 realpath（同步读接口不能 await）。
 * 与宿主 lease 的 `normalizeSessionOperationPath` 在「同一拼法」下一致；调用方两边都应传原始拼法。
 */
export function normalizeSessionOperationPathSync(path: string): string {
  const resolved = resolve(path.trim());
  const slashed = resolved.split("\\").join("/");
  return slashed.replace(/\/+$/, "").toLowerCase();
}

/** 阻塞状态无法确认（快照抛错 / 形状不对）：调用方必须 fail-closed，不能当成「没有阻塞」。 */
export class SessionOperationGateUnknownError extends Error {
  readonly code = "SESSION_OPERATION_GATE_UNKNOWN";
  constructor(cause?: unknown) {
    super(`SESSION_OPERATION_GATE_UNKNOWN${cause instanceof Error ? `: ${cause.message}` : ""}`);
    this.name = "SessionOperationGateUnknownError";
  }
}

/**
 * 当前阻塞族的同步快照（规范化路径集合）。没有注入时为空（旧宿主 / CLI / 测试行为不变）。
 * 注入了但快照读坏：抛 `SessionOperationGateUnknownError`，不返回空集合——
 * 空集合等于「没有半迁移族」，正是这里最不能猜的一侧。
 */
export function sessionOperationBlockedPaths(): ReadonlySet<string> {
  const snapshot = blockedSnapshot;
  if (!snapshot) return new Set();
  let paths: readonly string[];
  try {
    paths = snapshot();
  } catch (error) {
    throw new SessionOperationGateUnknownError(error);
  }
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) {
    throw new SessionOperationGateUnknownError(new Error("blocked snapshot is not a string array"));
  }
  return new Set(paths.map((path) => normalizeSessionOperationPathSync(path)));
}

export function isSessionOperationBlocked(path: string | null | undefined): boolean {
  if (!path || !path.trim()) return false;
  return sessionOperationBlockedPaths().has(normalizeSessionOperationPathSync(path));
}

/** 有注入的 guard 就按路径取锁；没有就透传。paths 去空、去重后交给宿主。 */
export function withSessionOperationGuard<T>(paths: readonly string[], operation: () => Promise<T>): Promise<T> {
  const guard = installed;
  if (!guard) return operation();
  const wanted = [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
  if (wanted.length === 0) return operation();
  return guard(wanted, operation);
}

/**
 * 只读查询：被未完成迁移阻塞的原因。没有注入闸门 → 空数组（旧宿主、CLI、测试行为不变）。
 * 只屏蔽受影响族，同一项目其他会话不受影响。
 */
export async function sessionOperationBlockers(query: {
  paths?: readonly string[];
  workspaces?: readonly string[];
}): Promise<readonly SessionOperationBlocker[]> {
  const gate = readGate;
  if (!gate) return [];
  const paths = (query.paths ?? []).map((path) => path.trim()).filter(Boolean);
  const workspaces = (query.workspaces ?? []).map((workspace) => workspace.trim()).filter(Boolean);
  if (paths.length === 0 && workspaces.length === 0) return [];
  return gate({ ...(paths.length > 0 ? { paths } : {}), ...(workspaces.length > 0 ? { workspaces } : {}) });
}

/** 这些路径里第一个被阻塞的原因；可用于单次唤醒 / 冷恢复前的快速闸门。 */
export async function firstSessionOperationBlocker(
  query: { paths?: readonly string[]; workspaces?: readonly string[] },
): Promise<SessionOperationBlocker | undefined> {
  return (await sessionOperationBlockers(query))[0];
}

/** 仅供定向测试。 */
export function __resetSessionOperationGuardForTest(): void {
  installed = undefined;
  readGate = undefined;
  blockedSnapshot = undefined;
}
