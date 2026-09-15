export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 17;
export const FONT_SIZE_DEFAULT = 14;

export function clampFontSize(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return FONT_SIZE_DEFAULT;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n)));
}
