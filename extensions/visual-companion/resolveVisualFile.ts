import { isAbsolute, relative, resolve } from "node:path";

/** 工作区内的 .html / .htm。拒绝跳出工作区的路径。 */
export function resolveVisualFile(cwd: string, filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) throw new Error("show_visual: path 不能为空");
  const root = resolve(cwd);
  const abs = resolve(isAbsolute(trimmed) ? trimmed : resolve(root, trimmed));
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("show_visual: 路径必须在当前工作区内");
  }
  if (!/\.html?$/i.test(abs)) {
    throw new Error("show_visual: 只打开 .html 文件");
  }
  return abs;
}
