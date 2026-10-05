import { pi } from '../lib/pi';
import { pathsEquivalent } from '../lib/pathUtils';
import { useSessionStore } from '../store';
import { agentStoreRegistry, useAgentRegistryStore } from './agentStoreRegistry';
import type { ChatMessage } from './agentReducer';
import { captureRunningEpochs, reconcileRunningSessions, workspacesMovedSince } from './runningSessions';

export interface RunningTurn {
  workspace: string;
  sessionId?: string;
  sessionPath?: string;
}

/**
 * 快照里仍在跑、且这段等待期间没有新的 agent_start/agent_end/agent_settled 的工作区。
 * 纪元变了说明实时事件已经改过运行态，不能再用这份过期快照覆盖。
 */
export function planRunningRestore(
  turns: readonly RunningTurn[],
  epochsAtRequest: ReadonlyMap<string, number>,
  epochNow: (workspace: string) => number | undefined,
): RunningTurn[] {
  const planned: RunningTurn[] = [];
  for (const turn of turns) {
    if (!turn.workspace) continue;
    const before = epochsAtRequest.get(turn.workspace);
    if (before !== undefined && epochNow(turn.workspace) !== before) continue;
    planned.push(turn);
  }
  return planned;
}

/**
 * 恢复一个已经在跑、但画面没有计时起点的会话（重载、重启后）：用最后一条用户请求的时间，
 * 没有就从现在算。起点写进 store，状态行重挂也不会每次从零开始。
 */
export function restoredRunStartedAt(messages: readonly ChatMessage[], now = Date.now()): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.kind !== 'user' || message.steering) continue;
    return typeof message.timestamp === 'number' && message.timestamp > 0 && message.timestamp <= now
      ? message.timestamp
      : now;
  }
  return now;
}

let ticket = 0;

interface SessionRunState {
  isStreaming?: boolean;
  sessionFile?: unknown;
  sessionId?: unknown;
}

/**
 * 优先用清单命令。主进程没重启时这个命令还不存在，退回已有的 agent_get_state。
 * 返回 null 表示两边都没读成，调用方不能把界面上的运行态清掉。
 */
export async function loadRunningTurns(
  list: () => Promise<RunningTurn[]>,
  getState: (workspace: string) => Promise<SessionRunState>,
  activeWorkspace: string | null,
): Promise<RunningTurn[] | null> {
  try {
    return await list();
  } catch {
    if (!activeWorkspace) return [];
    try {
      const state = await getState(activeWorkspace);
      if (state?.isStreaming !== true) return [];
      const sessionId = typeof state.sessionId === 'string' ? state.sessionId : undefined;
      const sessionPath = typeof state.sessionFile === 'string' ? state.sessionFile : undefined;
      return [{
        workspace: activeWorkspace,
        ...(sessionId ? { sessionId } : {}),
        ...(sessionPath ? { sessionPath } : {}),
      }];
    } catch {
      return null;
    }
  }
}

/** 向主进程读取仍在跑的回合，写回 isStreaming / runActive 和侧边栏会话路径。 */
export async function restoreRunningTurns(): Promise<void> {
  const mine = ++ticket;
  const runningEpochs = captureRunningEpochs();
  const epochs = new Map<string, number>();
  for (const workspace of agentStoreRegistry.keys()) {
    const store = agentStoreRegistry.get(workspace);
    if (store) epochs.set(workspace, store.getStreamEpoch());
  }
  const turns = await loadRunningTurns(
    () => pi.listRunningTurns(),
    (workspace) => pi.getState(workspace) as Promise<SessionRunState>,
    useSessionStore.getState().activeWorkspace || null,
  );
  if (turns == null || mine !== ticket) return;

  const planned = planRunningRestore(turns, epochs, (workspace) => agentStoreRegistry.get(workspace)?.getStreamEpoch());
  const live = new Set(planned.map((turn) => turn.workspace));
  const nextPaths = { ...useAgentRegistryStore.getState().runningPaths };
  let pathsChanged = false;
  const sessionState = useSessionStore.getState();

  for (const turn of planned) {
    const store = agentStoreRegistry.get(turn.workspace) ?? agentStoreRegistry.getOrCreate(turn.workspace);
    const loaded = store.getLoadedSessionPath();
    // 画面没绑定会话（草稿）时不算在看这份：否则草稿会因为同项目另一个会话在跑而显示停止按钮。
    const viewingThis = !turn.sessionPath || (loaded != null && pathsEquivalent(loaded, turn.sessionPath));
    const current = store.useStore.getState();
    if (viewingThis && !current.isStreaming) {
      store.useStore.setState({
        isStreaming: true,
        runActive: true,
        ...(current.runStartedAt ? {} : { runStartedAt: restoredRunStartedAt(current.messages) }),
      });
    }
    const remembered = sessionState.workspaceSessionPaths[turn.workspace];
    const viewingWorkspace = sessionState.activeWorkspace != null && pathsEquivalent(sessionState.activeWorkspace, turn.workspace);
    if (turn.sessionPath && !remembered && !(viewingWorkspace && sessionState.activeSessionPath)) {
      if (nextPaths[turn.workspace] !== turn.sessionPath) {
        nextPaths[turn.workspace] = turn.sessionPath;
        pathsChanged = true;
      }
      useSessionStore.getState().setWorkspaceSessionPath(turn.workspace, turn.sessionPath);
    } else if (turn.sessionPath && nextPaths[turn.workspace] !== turn.sessionPath && !viewingWorkspace) {
      nextPaths[turn.workspace] = turn.sessionPath;
      pathsChanged = true;
    }
  }

  for (const workspace of epochs.keys()) {
    const store = agentStoreRegistry.get(workspace);
    if (!store || store.getStreamEpoch() !== epochs.get(workspace)) continue;
    const loaded = store.getLoadedSessionPath();
    const viewingTurn = planned.some((turn) =>
      turn.workspace === workspace && (!turn.sessionPath || (loaded != null && pathsEquivalent(loaded, turn.sessionPath))),
    );
    if (viewingTurn) continue;
    if (store.useStore.getState().isStreaming) {
      store.useStore.setState({ isStreaming: false, runActive: false });
    }
    if (!live.has(workspace) && workspace in nextPaths) {
      delete nextPaths[workspace];
      pathsChanged = true;
    }
  }

  if (pathsChanged) useAgentRegistryStore.setState({ runningPaths: nextPaths });
  // 快照期间纪元变过的 workspace 以实时事件为准，其余按主进程快照对账。
  // 后台会话的事件不进前景 store 的纪元，另看 runningSessions 自己的纪元。
  const moved = workspacesMovedSince(runningEpochs);
  for (const [workspace, before] of epochs) {
    if (agentStoreRegistry.get(workspace)?.getStreamEpoch() !== before) moved.add(workspace);
  }
  reconcileRunningSessions(turns, moved);
}

const hot = (import.meta as ImportMeta & { hot?: { accept: (cb: () => void) => void } }).hot;
hot?.accept(() => {
  void restoreRunningTurns();
});
