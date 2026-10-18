import { statSync } from 'node:fs';
import { resolve } from 'node:path';

export interface PresentFile { path: string; description?: string }
export type PresentResult =
  | { ok: true; files: PresentFile[] }
  | { ok: false; error: string };

const MAX = 8;

/**
 * 声明交付文件。照 DSH tool-present：相对路径按会话当前工作目录解析，绝对路径可以指向工作区之外；
 * 只做一次 stat（不读内容），并把解析后的绝对路径记进结果，之后再切换工作目录也不会改指向。
 */
export function presentFiles(cwd: string, files: PresentFile[]): PresentResult {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX) {
    return { ok: false, error: `present accepts 1 to ${MAX} files` };
  }
  const out: PresentFile[] = [];
  for (const file of files) {
    const path = typeof file.path === 'string' ? file.path.trim() : '';
    if (!path) return { ok: false, error: 'present requires a non-empty file path' };
    const abs = resolve(cwd, path);
    try {
      const info = statSync(abs);
      if (!info.isFile()) return { ok: false, error: `Cannot present ${file.path}: not a regular file` };
    } catch {
      return { ok: false, error: `Cannot present ${file.path}: file not found. Check the path, create the file if needed, and retry.` };
    }
    out.push({
      path: abs,
      ...(typeof file.description === 'string' ? { description: file.description } : {}),
    });
  }
  return { ok: true, files: out };
}
