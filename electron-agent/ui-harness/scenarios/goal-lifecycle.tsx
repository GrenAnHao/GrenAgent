import { type ReactElement } from 'react';
import { AgentStoreContext } from '../../src/stores/AgentStoreContext';
import type { AgentStoreApi } from '../../src/stores/agent';
import { useGoalStore, type GoalSnapshot } from '../../src/stores/goalStore';
import { useSessionStore } from '../../src/store/session';
import { applyGoalStatus, refreshGoalStatus } from '../../src/features/extensionUi/goalStatus';
import { GoalPill } from '../../src/features/chat/input/GoalPill';
import { exposeActions, exposeData, installBridge, track } from '../stubs';

const WS = '/goal-lifecycle';
const A = `${WS}/a.jsonl`;
const B = `${WS}/b.jsonl`;
const BASE: GoalSnapshot = {
  sessionId: 'goal-session-a', goalId: 'goal-a', revision: 2, conditionRevision: 1,
  condition: '完成目标生命周期验收', status: 'active', activation: 'armed',
  roundsStarted: 1, runNumber: 1, runRoundsStarted: 1, maxRounds: 2,
  createdAt: '2026-11-17T00:00:00Z', updatedAt: '2026-11-17T00:00:10Z', ranMs: 125_000,
  history: [{ source: 'round', goalId: 'goal-a', revision: 2, round: 1, runNumber: 1, runRound: 1, content: '第一轮' }],
};
let latest: GoalSnapshot = BASE;
let sequence = 0;
let pullOverride: unknown;
let pendingPull: ((value: unknown) => void) | undefined;
let pendingEdit: { args: Record<string, unknown>; resolve: (value: unknown) => void } | undefined;
let editMode: 'hold' | 'fail' | 'conflict' | 'commit' = 'hold';
const envelope = (value: GoalSnapshot | null) => ({ schemaVersion: 1, sessionId: 'goal-session-a', source: 'live', ownerEpoch: 'goal-owner-a', sequence: ++sequence, snapshot: value, ...(value?.runtimeUnavailable ? { unavailable: value.runtimeUnavailable } : {}) });
function publish(patch: Partial<GoalSnapshot>): void {
  latest = { ...latest, ...patch };
  applyGoalStatus(envelope(latest), undefined, A);
}
function receipt(args: Record<string, unknown>, outcome: string, committedSnapshot: GoalSnapshot | null = null) {
  return {
    operationId: args.operationId, action: args.action, sessionId: 'goal-session-a', goalId: 'goal-a',
    ownerEpoch: 'goal-owner-a', expectedConditionRevision: args.expectedConditionRevision, outcome,
    ...(committedSnapshot ? { committedRevision: committedSnapshot.revision } : {}), snapshot: committedSnapshot,
    status: envelope(latest),
  };
}

installBridge({
  invoke: async (command: string, args: Record<string, unknown>) => {
    if (command === 'agent_get_goal') {
      track(`pull:${String(args.targetSessionPath)}`);
      if (pendingPull) return new Promise((resolve) => { pendingPull = resolve; });
      return pullOverride ?? envelope(latest);
    }
    if (command === 'agent_goal_control') {
      track(`control:${String(args.targetSessionPath)}:${String(args.action)}:${String(args.operationId)}`);
      if (args.action === 'edit') {
        if (editMode === 'hold') return new Promise((resolve) => { pendingEdit = { args, resolve }; });
        if (editMode === 'fail') return receipt(args, 'failed');
        if (editMode === 'conflict') return receipt(args, 'conflict');
        publish({ condition: String(args.condition), conditionRevision: latest.conditionRevision! + 1, revision: latest.revision + 1 });
        return receipt(args, 'committed', latest);
      }
      if (args.action === 'resume') {
        publish({ status: 'active', activation: 'armed', pauseReason: undefined, runNumber: latest.runNumber! + 1,
          runRoundsStarted: 0, revision: latest.revision + 1 });
      } else if (args.action === 'pause') publish({ status: 'paused', activation: 'disarmed', pauseReason: { code: 'user' }, revision: latest.revision + 1 });
      else if (args.action === 'clear') {
        useGoalStore.getState().acceptStatus('goal-session-a', undefined, envelope(null));
        return receipt(args, 'committed');
      }
      return receipt(args, 'committed', latest);
    }
    throw new Error(`Unexpected bridge command ${command}`);
  },
});
useSessionStore.setState({ activeSessionPath: A, activeWorkspace: WS });
useGoalStore.getState().bindSessionPath(A, 'goal-session-a');
applyGoalStatus(envelope(latest), undefined, A);
exposeData({ path: A, otherPath: B });
exposeActions({
  round: () => publish({ revision: latest.revision + 1, roundsStarted: latest.roundsStarted + 1, runRoundsStarted: latest.runRoundsStarted! + 1 }),
  failure: () => publish({ status: 'paused', activation: 'disarmed', runStartedAt: undefined,
    pauseReason: { code: 'request-error', message: '请求重试已耗尽' }, revision: latest.revision + 1 }),
  exhausted: () => publish({ status: 'paused', activation: 'disarmed', runStartedAt: undefined,
    pauseReason: { code: 'max-rounds' }, roundsStarted: 2, runRoundsStarted: 2, revision: latest.revision + 1 }),
  unavailable: () => publish({ status: 'active', activation: 'disarmed', pauseReason: undefined, runtimeUnavailable: 'GOAL_WRITE_FAILED', runStartedAt: undefined }),
  externalEdit: (condition: string) => publish({ condition, conditionRevision: latest.conditionRevision! + 1, revision: latest.revision + 1 }),
  editMode: (mode: typeof editMode) => { editMode = mode; },
  releaseEdit: (outcome: string) => {
    if (!pendingEdit) return;
    const { args, resolve } = pendingEdit;
    pendingEdit = undefined;
    if (outcome === 'committed') {
      publish({ condition: String(args.condition), conditionRevision: Number(args.expectedConditionRevision) + 1, revision: Number(args.expectedRevision) + 1 });
      resolve(receipt(args, outcome, latest));
    } else resolve(receipt(args, outcome));
  },
  holdPull: () => { pendingPull = () => {}; void refreshGoalStatus(WS, A); },
  releasePull: () => { const release = pendingPull; pendingPull = undefined; release?.(pullOverride ?? envelope(latest)); },
  stalePull: () => { pullOverride = { ...envelope(BASE), sequence: 1 }; },
  freshPull: () => { pullOverride = undefined; },
  switchSession: (path: string) => useSessionStore.setState({ activeSessionPath: path }),
});
const context = { workspace: WS, store: { getLoadedSessionPath: () => useSessionStore.getState().activeSessionPath } as AgentStoreApi,
  workspaceReady: false, setWorkspaceReady: () => {}, appBooted: true };
export default function GoalLifecycleScenario(): ReactElement {
  return <AgentStoreContext.Provider value={context}>
    <main style={{ width: 'min(100%, 740px)', boxSizing: 'border-box', padding: 24, background: 'var(--gren-content-bg)', minHeight: '100vh' }}>
      <GoalPill />
    </main>
  </AgentStoreContext.Provider>;
}
