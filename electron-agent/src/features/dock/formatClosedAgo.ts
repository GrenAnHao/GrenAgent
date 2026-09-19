/** Codex 式相对时间：刚刚 / N分 / N小时 / N天。 */
export function formatClosedAgo(at: number, now = Date.now()): string {
  const sec = Math.max(0, Math.floor((now - at) / 1000));
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}小时`;
  return `${Math.floor(hour / 24)}天`;
}
