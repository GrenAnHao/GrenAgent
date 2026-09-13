/** 不超过这么多条才允许 smooth：virtua 警告大跨度平滑滚动会沿途挂载中间项，毁掉虚拟化。 */
export const SMOOTH_JUMP_MAX_ITEMS = 4;

export function shouldSmoothScroll(fromIndex: number, toIndex: number): boolean {
  return Math.abs(toIndex - fromIndex) <= SMOOTH_JUMP_MAX_ITEMS;
}
