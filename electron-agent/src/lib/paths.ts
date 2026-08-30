/** 规范化路径用于比较（Windows 分隔符与大小写）。 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
}

export function pathsEqual(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return normalizePath(a) === normalizePath(b);
}
