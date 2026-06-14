/** Normalize path for cross-platform comparison (Windows-friendly). */
export function pathsEquivalent(a: string, b: string): boolean {
  const na = a.replace(/\\/g, '/').replace(/\/$/, '');
  const nb = b.replace(/\\/g, '/').replace(/\/$/, '');
  return na.toLowerCase() === nb.toLowerCase();
}
