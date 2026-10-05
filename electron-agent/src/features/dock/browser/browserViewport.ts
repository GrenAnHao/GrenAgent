export type BrowserViewportSize = {
  width: number;
  height: number;
};

export const BROWSER_VIEWPORT_LIMITS = {
  minWidth: 320,
  maxWidth: 3840,
  minHeight: 320,
  maxHeight: 2160,
} as const;

export const DEFAULT_BROWSER_VIEWPORT: BrowserViewportSize = {
  width: 393,
  height: 852,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function clampBrowserViewport(size: BrowserViewportSize): BrowserViewportSize {
  return {
    width: clamp(size.width, BROWSER_VIEWPORT_LIMITS.minWidth, BROWSER_VIEWPORT_LIMITS.maxWidth),
    height: clamp(size.height, BROWSER_VIEWPORT_LIMITS.minHeight, BROWSER_VIEWPORT_LIMITS.maxHeight),
  };
}

export function parseViewportDimension(value: string, axis: 'width' | 'height'): number | null {
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed)) return null;
  const min = axis === 'width' ? BROWSER_VIEWPORT_LIMITS.minWidth : BROWSER_VIEWPORT_LIMITS.minHeight;
  const max = axis === 'width' ? BROWSER_VIEWPORT_LIMITS.maxWidth : BROWSER_VIEWPORT_LIMITS.maxHeight;
  if (parsed < min || parsed > max) return null;
  return parsed;
}
