export function formatGoalElapsed(updatedAt: string, now: number = Date.now()): string {
  const started = Date.parse(updatedAt);
  const elapsedMs = Number.isFinite(started) ? Math.max(0, now - started) : 0;
  const seconds = Math.max(1, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}
