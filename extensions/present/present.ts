import { statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

export interface PresentFile { path: string; description?: string }
export type PresentResult =
  | { ok: true; files: PresentFile[] }
  | { ok: false; error: string };

const MAX = 8;

function underCwd(path: string, cwd: string): boolean {
  const base = resolve(cwd);
  const target = resolve(cwd, path);
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
}

export function presentFiles(cwd: string, files: PresentFile[]): PresentResult {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX) {
    return { ok: false, error: `present accepts 1 to ${MAX} files` };
  }
  const out: PresentFile[] = [];
  for (const file of files) {
    const path = typeof file.path === 'string' ? file.path.trim() : '';
    if (!path) return { ok: false, error: 'present requires a non-empty file path' };
    if (!underCwd(path, cwd) || (isAbsolute(path) && !underCwd(path, cwd))) {
      return { ok: false, error: `Cannot present ${file.path}: outside workspace` };
    }
    const abs = resolve(cwd, path);
    try {
      const info = statSync(abs);
      if (!info.isFile()) return { ok: false, error: `Cannot present ${file.path}: not a regular file` };
    } catch {
      return { ok: false, error: `Cannot present ${file.path}: file not found` };
    }
    out.push({
      path: file.path,
      ...(typeof file.description === 'string' ? { description: file.description } : {}),
    });
  }
  return { ok: true, files: out };
}
