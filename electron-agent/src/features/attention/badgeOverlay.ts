/** 任务栏覆盖图标上的文字：超过 9 写 9+。 */
export function badgeText(count: number): string {
  return count > 9 ? '9+' : String(count);
}

const SIZE = 32;

/**
 * Windows 任务栏覆盖图标：32×32 红底白字圆，交给主进程 setOverlayIcon。
 * count ≤ 0 或拿不到 2d context 时返回 undefined（主进程清掉图标）。
 */
export function drawBadgeOverlay(count: number): string | undefined {
  if (count <= 0 || typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    ctx = null;
  }
  if (!ctx) return undefined;
  ctx.fillStyle = '#d93026';
  ctx.beginPath();
  ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2);
  ctx.fill();
  const text = badgeText(count);
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${text.length > 1 ? 16 : 20}px "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, SIZE / 2, SIZE / 2 + 1);
  try {
    return canvas.toDataURL('image/png');
  } catch {
    return undefined;
  }
}
