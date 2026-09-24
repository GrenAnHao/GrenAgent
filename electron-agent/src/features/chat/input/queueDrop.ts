export function queueDropBeforeId(
  rows: readonly { id: string; top: number; bottom: number }[],
  draggingId: string,
  clientY: number,
): string | null {
  const others = rows.filter((row) => row.id !== draggingId);
  const hit = others.find((row) => clientY < (row.top + row.bottom) / 2);
  return hit?.id ?? null;
}
