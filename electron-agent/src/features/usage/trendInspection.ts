export interface BarBounds { left: number; right: number; top: number }

/** Stay above the anchor and any taller neighbours beneath the bubble's actual footprint. */
export function placeTrendTip(card: {left:number; right:number}, bar: BarBounds, width: number, neighbours: Iterable<BarBounds>) {
  const center = (bar.left + bar.right) / 2;
  const left = Math.max(card.left, Math.min(center - width / 2, card.right - width));
  let bottom = bar.top - 10;
  for (const other of neighbours) {
    if (other.right > left && other.left < left + width) bottom = Math.min(bottom, other.top - 10);
  }
  return { left, bottom, anchor: center - left, stem: bar.top - bottom };
}

// The key is already a local calendar date. UTC here preserves that label on every display timezone.
const weekday = new Intl.DateTimeFormat('zh-CN', {timeZone:'UTC', weekday:'short'});
export const weekdayOf = (date: string) => weekday.format(new Date(date + 'T12:00:00Z'));
