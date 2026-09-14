export function scrollbarGutterPx(offsetWidth: number, clientWidth: number): number {
  const n = offsetWidth - clientWidth;
  return n > 0 ? n : 0;
}
