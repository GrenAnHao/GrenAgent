export function queueSummaryLabel(items: readonly { text: string }[]): string {
  if (items.length === 0) return '';
  const text = items[0]?.text.trim() ?? '';
  return text ? `排队 · ${items.length} · ${text}` : `排队 · ${items.length}`;
}
