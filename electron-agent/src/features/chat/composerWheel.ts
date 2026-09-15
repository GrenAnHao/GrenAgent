export function scrollbarGutterPx(offsetWidth: number, clientWidth: number): number {
  const n = offsetWidth - clientWidth;
  return n > 0 ? n : 0;
}

export function draftShouldForwardWheel(p: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  deltaY: number;
}): boolean {
  if (p.deltaY === 0) return false;
  if (p.deltaY < 0) return p.scrollTop <= 0;
  return p.scrollTop + p.clientHeight >= p.scrollHeight - 1;
}
