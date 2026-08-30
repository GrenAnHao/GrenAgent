/** 归一化路径用于比较：统一分隔符、去 Windows `\\?\` 扩展前缀与尾斜杠、转小写。 */
function normalizePath(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/^\/\/\?\//, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** Normalize path for cross-platform comparison (Windows-friendly). */
export function pathsEquivalent(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

/** Whether `cwd` is the same as, or located under, `root` (Windows-friendly). */
export function isUnder(cwd: string, root: string): boolean {
  if (!cwd || !root) return false;
  const c = normalizePath(cwd);
  const r = normalizePath(root);
  return c === r || c.startsWith(r + '/');
}
