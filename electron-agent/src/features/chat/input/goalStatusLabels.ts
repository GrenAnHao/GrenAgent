import type { GoalSnapshot } from '../../../stores/goalStore';

export function goalPauseLabel(snapshot: GoalSnapshot): string | undefined {
  if (snapshot.runtimeUnavailable) return `已停止，暂停未保存：${snapshot.runtimeUnavailable}`;
  if (snapshot.pauseReason?.code === 'max-rounds') return '已达本批次轮次上限';
  if (snapshot.pauseReason?.code === 'user') return '用户已停止';
  if (snapshot.pauseReason?.code === 'request-error') return `请求失败${snapshot.pauseReason.message ? `：${snapshot.pauseReason.message}` : ''}`;
  if (snapshot.pauseReason?.code === 'runtime-error') return `运行异常${snapshot.pauseReason.message ? `：${snapshot.pauseReason.message}` : ''}`;
  return undefined;
}

export function goalNeedsRestart(snapshot: GoalSnapshot): boolean {
  return snapshot.pauseReason?.code === 'max-rounds'
    || snapshot.status !== 'complete' && (snapshot.runRoundsStarted ?? snapshot.roundsStarted) >= snapshot.maxRounds;
}
