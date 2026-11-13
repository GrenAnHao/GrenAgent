import { onPiEvent, onPiExit, type PiEventEnvelope, type PiExitEnvelope } from '../lib/pi';
import { pathKey, pathsEquivalent } from '../lib/pathUtils';
import { useAgentRegistryStore } from './agentStoreRegistry';

/**
 * 侧边栏的「运行中」按会话路径记，由事件驱动：agent_start 点亮，agent_end（不重试）/
 * agent_settled / pi://exit 熄灭。不看前景 store 的 isStreaming，否则后台会话跑完了
 * 侧边栏仍亮着，或者两个会话同时跑时只能亮一个。
 *
 * 对账按「会话」而不是「项目」记纪元：同一项目里 A 刚跑完、B 又开始了，按项目记的纪元会变，
 * 于是等待中的旧快照整份被放弃，A 这种丢了终态事件的陈旧条目就再也没机会被清掉。
 */
const byWorkspace = new Map<string, string[]>();
/** 每个 workspace / 会话收到运行态事件的次数。快照对账用它判断等待期间有没有新事件。 */
const epochs = new Map<string, number>();

// 整项目级的键就是 workspace 本身；会话级用 JSON 数组，避免路径里出现分隔符拼串歧义。
const epochKey = (workspace: string, sessionPath?: string): string =>
  sessionPath ? runningSessionKey(workspace, sessionPath) : workspace;

/** 会话级运行态键（对账 / 纪元共用），路径按 pathsEquivalent 的规则归一。 */
export function runningSessionKey(workspace: string, sessionPath: string): string {
  return JSON.stringify([workspace, pathKey(sessionPath)]);
}

/**
 * 记账分行级与项目级：
 * - 会话级键：这个会话收到过运行态事件。对账时用它判断「这份会话自己有没有新结果」。
 * - 项目级键：整个项目的 runtime 没了（没有路径的 pi://exit）。
 *
 * 以前每个 agent_start 都会 bump 项目级键，于是同项目里任何一份会话动一下，等待中的快照
 * 就整份作废；丢了终态事件的陈旧会话因此永远清不掉，一直是「执行中」、取消也没反应。
 */
function bumpProject(workspace: string): void {
  epochs.set(workspace, (epochs.get(workspace) ?? 0) + 1);
}

function bumpSession(workspace: string, sessionPath: string): void {
  const key = epochKey(workspace, sessionPath);
  epochs.set(key, (epochs.get(key) ?? 0) + 1);
}

/** 发快照请求前记下各会话的纪元，回来后传给 reconcileRunningSessions。 */
export function captureRunningEpochs(): Map<string, number> {
  return new Map(epochs);
}

/** 记录之后整个项目退出过的 workspace（项目级纪元变化）。 */
export function workspacesMovedSince(before: ReadonlyMap<string, number>): Set<string> {
  const moved = new Set<string>();
  for (const [workspace, now] of epochs) {
    // 会话级键是 JSON 数组；这里只看整项目级别的条目。
    if (workspace.startsWith('[')) continue;
    if ((before.get(workspace) ?? 0) !== now) moved.add(workspace);
  }
  return moved;
}

/** 记录之后有新运行态事件的会话键。对账时这些会话以实时事件为准。 */
export function sessionsMovedSince(before: ReadonlyMap<string, number>): Set<string> {
  const moved = new Set<string>();
  for (const [key, now] of epochs) {
    if (!key.startsWith('[')) continue;
    if ((before.get(key) ?? 0) !== now) moved.add(key);
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
  bumpSession(workspace, sessionPath);
  const list = byWorkspace.get(workspace) ?? [];
  if (list.some((path) => pathsEquivalent(path, sessionPath))) return;
  byWorkspace.set(workspace, [...list, sessionPath]);
  publish();
}

export function markSessionIdle(workspace: string, sessionPath: string): void {
  bumpSession(workspace, sessionPath);
  const list = byWorkspace.get(workspace);
  if (!list) return;
  const next = list.filter((path) => !pathsEquivalent(path, sessionPath));
  if (next.length === list.length) return;
  if (next.length) byWorkspace.set(workspace, next);
  else byWorkspace.delete(workspace);
  publish();
}

/**
 * 会话被删：不论记在哪个 workspace 下都熄灭。主进程拆掉停靠的 handle 时不再转发它的 agent_end，
 * 不在这里熄灭就一直记着。bump 纪元：等待中的旧快照不能再把它点亮。
 */
export function forgetRunningSession(sessionPath: string): void {
  let changed = false;
  for (const [workspace, list] of [...byWorkspace]) {
    const next = list.filter((path) => !pathsEquivalent(path, sessionPath));
    if (next.length === list.length) continue;
    bumpSession(workspace, sessionPath);
    changed = true;
    if (next.length) byWorkspace.set(workspace, next);
    else byWorkspace.delete(workspace);
  }
  if (changed) publish();
}

/**
 * 主进程快照对账：快照为准，但会话级保护优先。
 *
 * - `keep` 里的 workspace 整个跳过：那些 workspace 的实时事件比这份快照新。
 * - `keepPaths` 里的会话（等待期间它自己有了新事件）由实时事件决定，快照不覆盖它：
 *   快照说在跑、事件已收尾 → 保持熄灭；快照里没有、事件刚点亮 → 保持点亮。
 * - 其余会话严格按快照：快照里没有就熄灭。这是「丢了终态事件的会话一直转圈」的解药——
 *   同项目里别的会话刚开始跑，不能因此让这份陈旧条目躲过对账。
 */
export function reconcileRunningSessions(
  turns: ReadonlyArray<{ workspace: string; sessionPath?: string }>,
  /** 等快照期间已有实时事件改过的 workspace，保留事件给出的结果。 */
  keep: ReadonlySet<string> = new Set(),
  /** 等待期间该会话本身已有新事件：它由事件决定，快照不覆盖。 */
  keepPaths: ReadonlySet<string> = new Set(),
): void {
  const snapshot = new Map<string, string[]>();
  for (const turn of turns) {
    if (!turn.workspace || !turn.sessionPath) continue;
    const list = snapshot.get(turn.workspace) ?? [];
    list.push(turn.sessionPath);
    snapshot.set(turn.workspace, list);
  }
  const previous = new Map(byWorkspace);
  byWorkspace.clear();
  for (const workspace of new Set([...previous.keys(), ...snapshot.keys()])) {
    if (keep.has(workspace)) {
      const kept = previous.get(workspace);
      if (kept?.length) byWorkspace.set(workspace, [...kept]);
      continue;
    }
    const fromEvents = previous.get(workspace) ?? [];
    const lit: string[] = [];
    // 快照点亮的会话：这一份自己刚有事件的除外（事件已决定结果）。
    for (const path of snapshot.get(workspace) ?? []) {
      if (keepPaths.has(epochKey(workspace, path))) continue;
      lit.push(path);
    }
    // 事件点亮、快照里没有的会话：只有它自己刚有事件时才留下。
    for (const path of fromEvents) {
      if (lit.some((existing) => pathsEquivalent(existing, path))) continue;
      if (!keepPaths.has(epochKey(workspace, path))) continue;
      lit.push(path);
    }
    if (lit.length) byWorkspace.set(workspace, lit);
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

/**
 * 用户已经停掉 / 确认停掉的会话：直接熄灭，并 bump 纪元保证等待中的旧快照不能把它重新点亮。
 *
 * 侧栏以前只等 `agent_end` / `agent_settled` 熄灭。这两条一起丢（拆掉 handle 不再转发、
 * 订阅器报错、SDK 卡在不响应中止的等待里）时条目会一直亮着，取消也没有第二条熄灭入口。
 * 会话路径唯一，不依赖 workspace 拼法对得上，所以跨 workspace 一起清。
 */
export function markSessionStopped(sessionPath: string): void {
  forgetRunningSession(sessionPath);
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
  bumpProject(env.workspace);
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
