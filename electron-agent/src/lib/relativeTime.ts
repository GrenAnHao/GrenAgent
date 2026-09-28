/** 时间戳 → 中文相对时间（刚刚 / N分钟前 / N小时前 / N天前）。未来时间按“刚刚”处理。 */
export function formatRelative(ms: number, now: number = Date.now()): string {
  const sec = Math.floor(Math.max(0, now - ms) / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时前`;
  return `${Math.floor(hr / 24)}天前`;
}
