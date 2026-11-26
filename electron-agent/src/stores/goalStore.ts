import { create } from 'zustand';
import { sessionControlKey } from './modeStore';

export type GoalStatus = 'active' | 'paused' | 'blocked' | 'complete';

export type GoalHistoryItem =
  | {
      source: 'event';
      kind: string;
      goalId: string;
      revision: number;
      at: string;
      payload: Record<string, unknown>;
    }
  | {
      source: 'round';
      goalId: string;
      revision: number;
      round: number;
      runNumber?: number;
      runRound?: number;
      roundId?: string;
      content?: string;
    };

export interface GoalSnapshot {
  goalId: string;
  sessionId: string;
  revision: number;
  condition: string;
  status: GoalStatus;
  roundsStarted: number;
  runNumber?: number;
  runRoundsStarted?: number;
  conditionRevision?: number;
  maxRounds: number;
  createdAt: string;
  updatedAt: string;
  ranMs: number;
  runStartedAt?: string;
  activation: 'armed' | 'disarmed';
  blockedReason?: { code: string; message: string };
  pauseReason?: { code: 'user' | 'max-rounds' | 'request-error' | 'runtime-error'; message?: string };
  /** Owner stopped in memory but could not persist the pause. */
  runtimeUnavailable?: string;
  history?: GoalHistoryItem[];
}

/** 旧版 setStatus 投影的形状，仅保留给插件兼容层，不参与会话 Goal 渲染。 */
export interface GoalInfo {
  condition: string;
  paused: boolean;
  react: number;
}

export interface GoalStatusStamp {
  source?: 'live' | 'offline';
  ownerEpoch?: string;
  sequence?: number;
}
export interface GoalStatusWatermark extends GoalStatusStamp {
  retiredEpochs: string[];
}

export interface GoalStoreState {
  /** 当前会话 Goal 投影；sessionId 来自信封，是唯一索引。 */
  bySession: Record<string, GoalSnapshot>;
  /** Includes clear tombstones; only deleting a session releases its watermark. */
  watermarks: Record<string, GoalStatusWatermark>;
  mutationFences: Record<string, number>;
  acceptStatus: (sessionId: string, snapshot: GoalSnapshot | undefined, stamp: GoalStatusStamp, authoritativeOwner?: boolean) => boolean;
  mutationFence: (sessionPath: string) => number;
  bumpMutationFence: (sessionPath: string) => number;
  markOwnerLost: (sessionId: string, ownerEpoch: string, goalId: string, stoppedAt?: number) => void;
  /** 会话路径（sessionControlKey）→ sessionId。推送信封和补拉结果都会记，输入栏按当前会话路径找 Goal。 */
  sessionIdByPath: Record<string, string>;
  /** @deprecated 旧扩展状态兼容字段，禁止作为当前会话 Goal 的权威来源。 */
  goal?: GoalInfo;
  setSnapshot: (sessionId: string, snapshot?: GoalSnapshot) => void;
  getSnapshot: (sessionId: string) => GoalSnapshot | undefined;
  clearSnapshot: (sessionId: string, revision: number) => void;
  dropSession: (sessionId: string) => void;
  bindSessionPath: (sessionPath: string, sessionId: string) => void;
  /** @deprecated 仅供旧扩展状态兼容，不写入 bySession。 */
  setGoal: (goal?: GoalInfo) => void;
}

export const useGoalStore = create<GoalStoreState>((set, get) => ({
  bySession: {},
  watermarks: {},
  mutationFences: {},
  sessionIdByPath: {},

  mutationFence: (path) => get().mutationFences[sessionControlKey(path)] ?? 0,
  bumpMutationFence: (path) => {
    const key = sessionControlKey(path);
    const value = (get().mutationFences[key] ?? 0) + 1;
    set((state) => ({ mutationFences: { ...state.mutationFences, [key]: value } }));
    return value;
  },

  markOwnerLost: (sessionId, ownerEpoch, goalId, stoppedAt = Date.now()) => {
    if (!sessionId || !ownerEpoch || !goalId) return;
    set((state) => {
      const previous = state.watermarks[sessionId];
      if (previous?.ownerEpoch && previous.ownerEpoch !== ownerEpoch) return state;
      const snapshot = state.bySession[sessionId];
      if (!previous?.ownerEpoch && snapshot && snapshot.goalId !== goalId) return state;
      const retiredEpochs = [...new Set([...(previous?.retiredEpochs ?? []), ownerEpoch])];
      const watermarks = { ...state.watermarks, [sessionId]: { ...previous, source: 'live' as const, ownerEpoch, retiredEpochs } };
      if (!snapshot || snapshot.status !== 'active') return { watermarks };
      const { runStartedAt, ...frozen } = snapshot;
      const elapsed = runStartedAt ? stoppedAt - Date.parse(runStartedAt) : 0;
      return {
        watermarks,
        bySession: { ...state.bySession, [sessionId]: { ...frozen,
          ranMs: snapshot.ranMs + (Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0),
          activation: 'disarmed' as const, runtimeUnavailable: 'GOAL_OWNER_LOST',
        } },
      };
    });
  },

  acceptStatus: (sessionId, snapshot, stamp, authoritativeOwner = false) => {
    if (!sessionId.trim() || (snapshot && snapshot.sessionId !== sessionId)) return false;
    let accepted = false;
    set((state) => {
      const previous = state.watermarks[sessionId];
      const sequenced = stamp.source === 'live' && !!stamp.ownerEpoch
        && Number.isSafeInteger(stamp.sequence) && stamp.sequence! > 0;
      if (previous) {
        if (!sequenced && (previous.source !== 'offline' || stamp.source !== 'offline')) return state;
        if (previous.retiredEpochs.includes(stamp.ownerEpoch!)) return state;
        if (previous.source === 'live' && previous.ownerEpoch !== stamp.ownerEpoch && !authoritativeOwner) return state;
        if (previous.ownerEpoch === stamp.ownerEpoch && stamp.sequence! <= (previous.sequence ?? 0)) return state;
      }
      if (!sequenced && previous?.source === 'live') return state;
      const retiredEpochs = [...(previous?.retiredEpochs ?? [])];
      if (previous?.ownerEpoch && previous.ownerEpoch !== stamp.ownerEpoch) retiredEpochs.push(previous.ownerEpoch);
      const bySession = { ...state.bySession };
      if (snapshot) bySession[sessionId] = snapshot;
      else delete bySession[sessionId];
      accepted = true;
      return {
        bySession,
        // Old v1 envelopes may initialize a cold projection but do not invent
        // an ordering token. An offline tombstone still fences legacy replies.
        watermarks: sequenced || stamp.source === 'offline'
          ? { ...state.watermarks, [sessionId]: { ...stamp, retiredEpochs } }
          : state.watermarks,
      };
    });
    return accepted;
  },
  goal: undefined,

  setSnapshot: (sessionId, snapshot) => {
    if (!sessionId.trim()) return;
    set((state) => {
      const current = state.bySession[sessionId];
      // Goal revisions 是单调递增的 CAS 版本。迟到事件不能回写较新的 UI 投影。
      if (snapshot && snapshot.sessionId !== sessionId) return state;
      if (snapshot && current) {
        // 同版本号仍然接受：武装 / 解除武装不写事件、不涨 revision，只有这样 activation 才跟得上。
        if (snapshot.goalId === current.goalId && snapshot.revision < current.revision) return state;
        // A cleared Goal may be followed by a new generation whose revision
        // starts at 1. Prefer the newer generation, while rejecting a late
        // event from an older generation when its creation time is known.
        if (snapshot.goalId !== current.goalId) {
          const nextCreated = Date.parse(snapshot.createdAt);
          const currentCreated = Date.parse(current.createdAt);
          if (Number.isFinite(nextCreated) && Number.isFinite(currentCreated) && nextCreated < currentCreated) return state;
          if (Number.isFinite(nextCreated) && Number.isFinite(currentCreated) && nextCreated === currentCreated
            && snapshot.updatedAt < current.updatedAt) return state;
        }
      }
      const bySession = { ...state.bySession };
      if (snapshot) bySession[sessionId] = snapshot;
      else delete bySession[sessionId];
      return { bySession };
    });
  },

  getSnapshot: (sessionId) => get().bySession[sessionId],

  clearSnapshot: (sessionId, revision) => {
    if (!sessionId.trim() || !Number.isSafeInteger(revision)) return;
    set((state) => {
      const current = state.bySession[sessionId];
      if (!current || current.revision !== revision) return state;
      const bySession = { ...state.bySession };
      delete bySession[sessionId];
      return { bySession };
    });
  },

  dropSession: (sessionId) => {
    if (!sessionId.trim()) return;
    set((state) => {
      const bySession = { ...state.bySession };
      const watermarks = { ...state.watermarks };
      delete bySession[sessionId];
      delete watermarks[sessionId];
      return { bySession, watermarks };
    });
  },

  bindSessionPath: (sessionPath, sessionId) => {
    if (!sessionPath.trim() || !sessionId.trim()) return;
    const key = sessionControlKey(sessionPath);
    set((state) => (state.sessionIdByPath[key] === sessionId
      ? state
      : { sessionIdByPath: { ...state.sessionIdByPath, [key]: sessionId } }));
  },

  setGoal: (goal) => set({ goal }),
}));
