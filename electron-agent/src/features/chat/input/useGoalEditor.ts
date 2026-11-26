import { useCallback, useEffect, useRef, useState } from 'react';
import type { GoalControlAction, GoalControlReceipt, GoalControlRequest } from '../../../../../extensions/goal/control-contract';
import { pi } from '../../../lib/pi';
import { useGoalStore, type GoalSnapshot } from '../../../stores/goalStore';
import { refreshGoalStatus } from '../../extensionUi/goalStatus';

type PendingEdit = { workspace: string; path: string; sessionId: string; ownerEpoch?: string; request: GoalControlRequest };

function failureMessage(receipt: GoalControlReceipt): string {
  if (receipt.outcome === 'conflict') return '目标条件已变更，请选择载入最新版或基于最新版提交。';
  if (receipt.outcome === 'unavailable') return '目标暂不可用，草稿未保存。请重新读取后重试。';
  return receipt.message ? `目标未保存，草稿已保留：${receipt.message}` : '目标未保存，草稿已保留，请重试。';
}

/** Editor state is scoped to the session path and goal generation, never to a round revision. */
export function useGoalEditor(workspace: string | undefined, path: string | null | undefined, snapshot: GoalSnapshot | undefined) {
  const identity = `${workspace ?? ''}\n${path ?? ''}\n${snapshot?.sessionId ?? ''}\n${snapshot?.goalId ?? ''}`;
  const [draft, setDraft] = useState(snapshot?.condition ?? '');
  const [baseline, setBaseline] = useState(snapshot?.conditionRevision ?? 1);
  const [baseCondition, setBaseCondition] = useState(snapshot?.condition ?? '');
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef<PendingEdit | null>(null);
  const identityRef = useRef(identity);
  const busyRef = useRef(false);

  useEffect(() => {
    identityRef.current = identity;
    pending.current = null;
    busyRef.current = false;
    setBusy(false);
    setDraft(snapshot?.condition ?? '');
    setBaseCondition(snapshot?.condition ?? '');
    setBaseline(snapshot?.conditionRevision ?? 1);
    setError('');
    setConflict(false);
  }, [identity]);

  useEffect(() => {
    if (!snapshot || pending.current || conflict || (snapshot.conditionRevision ?? 1) < baseline) return;
    if (snapshot.condition === baseCondition) return;
    if (draft !== baseCondition) {
      setConflict(true);
      setError('目标条件已由其他操作修改，请选择载入最新版或基于最新版提交。');
    } else {
      setDraft(snapshot.condition);
      setBaseCondition(snapshot.condition);
      setBaseline(snapshot.conditionRevision ?? 1);
    }
  }, [snapshot?.condition, snapshot?.conditionRevision, baseCondition, draft, conflict, baseline]);

  const loadLatest = useCallback(() => {
    if (!snapshot || busyRef.current) return;
    pending.current = null;
    setDraft(snapshot.condition);
    setBaseCondition(snapshot.condition);
    setBaseline(snapshot.conditionRevision ?? 1);
    setError('');
    setConflict(false);
  }, [snapshot]);

  const rebase = useCallback(() => {
    if (!snapshot || busyRef.current) return;
    pending.current = null;
    setBaseCondition(snapshot.condition);
    setBaseline(snapshot.conditionRevision ?? 1);
    setError('');
    setConflict(false);
  }, [snapshot]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!workspace || !path || !snapshot || busyRef.current || conflict) return false;
    const condition = draft.trim();
    if (!condition || (condition === baseCondition && !pending.current)) return false;
    const watermark = useGoalStore.getState().watermarks[snapshot.sessionId];
    const attempt = pending.current?.request.condition === condition && pending.current.path === path
      && pending.current.sessionId === snapshot.sessionId && pending.current.request.goalId === snapshot.goalId
      ? pending.current
      : {
          workspace, path, sessionId: snapshot.sessionId, ownerEpoch: watermark?.ownerEpoch,
          request: {
            operationId: crypto.randomUUID(), action: 'edit' as const, goalId: snapshot.goalId,
            expectedRevision: snapshot.revision, expectedConditionRevision: baseline, condition,
          },
        };
    pending.current = attempt;
    busyRef.current = true;
    setBusy(true);
    setError('');
    useGoalStore.getState().bumpMutationFence(attempt.path);
    try {
      const receipt = await pi.goalControl(attempt.workspace, attempt.path, attempt.request);
      if (identityRef.current !== identity) return false;
      const ownerMatches = !!receipt.ownerEpoch && (!attempt.ownerEpoch || receipt.ownerEpoch === attempt.ownerEpoch);
      const matches = receipt.operationId === attempt.request.operationId && receipt.action === 'edit'
        && receipt.sessionId === attempt.sessionId && receipt.goalId === attempt.request.goalId
        && receipt.expectedConditionRevision === attempt.request.expectedConditionRevision && ownerMatches;
      if (!matches) {
        setError('回执与本次编辑不匹配，草稿未保存。请重新读取。');
        return false;
      }
      if (receipt.status && receipt.status.ownerEpoch === receipt.ownerEpoch) {
        useGoalStore.getState().bumpMutationFence(attempt.path);
        // The latest status is for display; only the operation's snapshot proves this save.
        const { applyGoalStatus } = await import('../../extensionUi/goalStatus');
        applyGoalStatus(receipt.status, undefined, attempt.path);
      }
      const committedSnapshot = receipt.snapshot;
      const committed = receipt.outcome === 'committed' && committedSnapshot !== null
        && receipt.committedRevision === committedSnapshot.revision
        && committedSnapshot.goalId === attempt.request.goalId
        && committedSnapshot.conditionRevision === attempt.request.expectedConditionRevision + 1
        && committedSnapshot.condition === condition
        && (!receipt.status?.ownerEpoch || receipt.status.ownerEpoch === receipt.ownerEpoch);
      if (!committed || !committedSnapshot) {
        setError(failureMessage(receipt));
        if (receipt.outcome === 'conflict') {
          pending.current = null;
          setConflict(true);
          void refreshGoalStatus(attempt.workspace, attempt.path);
        }
        return false;
      }
      pending.current = null;
      setBaseCondition(condition);
      setBaseline(committedSnapshot.conditionRevision);
      setDraft(condition);
      setError('');
      return true;
    } catch {
      if (identityRef.current === identity) setError('未收到提交回执，草稿未保存。重试会使用同一操作标识。');
      return false;
    } finally {
      useGoalStore.getState().bumpMutationFence(attempt.path);
      if (identityRef.current === identity) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }, [workspace, path, snapshot, draft, baseCondition, baseline, conflict, identity]);

  return { draft, setDraft, error, conflict, busy, save, loadLatest, rebase, dirty: draft !== baseCondition, baseCondition };
}

/** A transport failure leaves the operation ID reusable; owner replay decides whether it committed. */
const pendingActions = new Map<string, GoalControlRequest>();

/** UI control always targets the captured path, and never treats prompt acceptance as commit. */
export async function controlGoal(workspace: string, path: string, snapshot: GoalSnapshot, action: Exclude<GoalControlAction, 'create' | 'edit'>): Promise<GoalControlReceipt> {
  const key = `${workspace}\n${path}\n${snapshot.sessionId}\n${snapshot.goalId}\n${action}`;
  const request: GoalControlRequest = pendingActions.get(key) ?? {
    operationId: crypto.randomUUID(), action, goalId: snapshot.goalId,
    expectedRevision: snapshot.revision, expectedConditionRevision: snapshot.conditionRevision ?? 1,
  };
  pendingActions.set(key, request);
  useGoalStore.getState().bumpMutationFence(path);
  try {
    const receipt = await pi.goalControl(workspace, path, request);
    if (!receipt.ownerEpoch || receipt.operationId !== request.operationId || receipt.sessionId !== snapshot.sessionId || receipt.goalId !== snapshot.goalId
      || receipt.action !== action || receipt.expectedConditionRevision !== request.expectedConditionRevision) {
      throw new Error('目标控制回执与原会话不匹配');
    }
    if (receipt.status && receipt.status.ownerEpoch === receipt.ownerEpoch) {
      const { applyGoalStatus } = await import('../../extensionUi/goalStatus');
      applyGoalStatus(receipt.status, undefined, path);
    }
    if (receipt.outcome !== 'committed') {
      pendingActions.delete(key);
      throw new Error(failureMessage(receipt));
    }
    pendingActions.delete(key);
    return receipt;
  } finally {
    useGoalStore.getState().bumpMutationFence(path);
  }
}
