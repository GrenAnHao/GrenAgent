import { onPiEvent, onPiExit, type PiEventEnvelope, type PiExitEnvelope } from '../lib/pi';
import { pathsEquivalent } from '../lib/pathUtils';
import { useAgentRegistryStore } from './agentStoreRegistry';

/**
 * 侧边栏的「运行中」按会话路径记，由事件驱动：agent_start 点亮，agent_end（不重试）/
 * agent_settled / pi://exit 熄灭。不看前景 store 的 isStreaming，否则后台会话跑完了
 * 侧边栏仍亮着，或者两个会话同时跑时只能亮一个。
 */
const byWorkspace = new Map<string, string[]>();
/** 每个 workspace 收到运行态事件的次数。快照对账用它判断等待期间有没有新事件。 */
const epochs = new Map<string, number>();

function bump(workspace: string): void {
  epochs.set(workspace, (epochs.get(workspace) ?? 0) + 1);
}

/** 发快照请求前记下各 workspace 的纪元，回来后传给 reconcileRunningSessions。 */
export function captureRunningEpochs(): Map<string, number> {
  return new Map(epochs);
}

/** 记录之后有新运行态事件的 workspace。 */
export function workspacesMovedSince(before: ReadonlyMap<string, number>): Set<string> {
  const moved = new Set<string>();
  for (const [workspace, now] of epochs) {
    if ((before.get(workspace) ?? 0) !== now) moved.add(workspace);
  }
  return moved;
}

function publish(): void {
  const all: string[] = [];
  for (const paths of byWorkspace.values()) all.push(...paths);
  const prev = useAgentRegistryStore.getState().runningSessionPaths;
  if (prev.length === all.length && prev.every((path, index) => path === all[index])) return;
  useAgentRegistryStore.setState({ runningSessionPaths: all });
}

export function markSessionRunning(workspace: string, sessionPath: string): void {
  bump(workspace);
  const list = byWorkspace.get(workspace) ?? [];
  if (list.some((path) => pathsEquivalent(path, sessionPath))) return;
  byWorkspace.set(workspace, [...list, sessionPath]);
  publish();
}

export function markSessionIdle(workspace: string, sessionPath: string): void {
  bump(workspace);
  const list = byWorkspace.get(workspace);
  if (!list) return;
  const next = list.filter((path) => !pathsEquivalent(path, sessionPath));
  if (next.length === list.length) return;
  if (next.length) byWorkspace.set(workspace, next);
  else byWorkspace.delete(workspace);
  publish();
}

/** 主进程快照对账：快照里出现过的 workspace，以快照为准整体替换；没出现的全部熄灭。 */
export function reconcileRunningSessions(
  turns: ReadonlyArray<{ workspace: string; sessionPath?: string }>,
  /** 等快照期间已有实时事件改过的 workspace，保留事件给出的结果。 */
  keep: ReadonlySet<string> = new Set(),
): void {
  for (const workspace of [...byWorkspace.keys()]) {
    if (!keep.has(workspace)) byWorkspace.delete(workspace);
  }
  for (const turn of turns) {
    if (keep.has(turn.workspace)) continue;
    if (!turn.workspace || !turn.sessionPath) continue;
    const list = byWorkspace.get(turn.workspace) ?? [];
    if (!list.some((path) => pathsEquivalent(path, turn.sessionPath!))) list.push(turn.sessionPath);
    byWorkspace.set(turn.workspace, list);
  }
  publish();
}

/**
 * 侧边栏点亮集合：只认按路径的事件运行态。路径换成会话列表里的写法（大小写 / 分隔符可能不同），
 * Sidebar 用 Set.has 精确比较。
 */
export function resolveRunningSessionPaths(
  running: readonly string[],
  ...lists: ReadonlyArray<ReadonlyArray<{ path: string }>>
): Set<string> {
  const set = new Set<string>();
  for (const hinted of running) {
    if (!hinted) continue;
    let resolved = hinted;
    for (const list of lists) {
      const found = list.find((s) => pathsEquivalent(s.path, hinted));
      if (found) {
        resolved = found.path;
        break;
      }
    }
    set.add(resolved);
  }
  return set;
}

export function isSessionRunning(sessionPath: string): boolean {
  for (const list of byWorkspace.values()) {
    if (list.some((path) => pathsEquivalent(path, sessionPath))) return true;
  }
  return false;
}

export function handleRunningEvent(env: PiEventEnvelope): void {
  if (env.source === 'goal' || env.source === 'subagent') return;
  const path = typeof env.sessionPath === 'string' && env.sessionPath ? env.sessionPath : undefined;
  if (!path) return;
  const event = env.event as { type?: string; willRetry?: boolean };
  if (event.type === 'agent_start') markSessionRunning(env.workspace, path);
  else if (event.type === 'agent_settled') markSessionIdle(env.workspace, path);
  else if (event.type === 'agent_end' && event.willRetry !== true) markSessionIdle(env.workspace, path);
}

export function handleRunningExit(env: PiExitEnvelope): void {
  if (env.source === 'goal') return;
  if (env.sessionPath) {
    markSessionIdle(env.workspace, env.sessionPath);
    return;
  }
  // 没有路径的退出说明整个项目的 runtime 没了。
  bump(env.workspace);
  if (byWorkspace.delete(env.workspace)) publish();
}

export function resetRunningSessionsForTest(): void {
  byWorkspace.clear();
  epochs.clear();
  publish();
}

let started = false;

/** App 挂载时调一次。重复调用无副作用。 */
export function startRunningSessionTracking(): void {
  if (started) return;
  started = true;
  void onPiEvent(handleRunningEvent);
  void onPiExit(handleRunningExit);
}
