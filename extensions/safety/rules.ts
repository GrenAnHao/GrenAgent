import { resolve, sep } from "node:path";

const DANGEROUS_BASH = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive)/i,
  /\bsudo\b/i,
  /\b(chmod|chown)\b[^\n]*\b777\b/i,
  /\bmkfs\b/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, // fork bomb
  />\s*\/dev\/sd[a-z]/i,
];

export function isDangerousBash(command: string): boolean {
  return DANGEROUS_BASH.some((re) => re.test(command));
}

// 受保护路径判定移至 _shared/protected-paths：safety 的 write/edit 拦截与绕过型写工具
// （ast_edit/hl_edit）的写盘前自检共用同一份清单。此处 re-export 保持既有导入路径不变。
export { matchProtectedPath } from "../_shared/protected-paths.js";

export function extractPath(input: Record<string, unknown>): string | undefined {
  const v = input?.path ?? input?.file_path ?? input?.filePath;
  return typeof v === "string" ? v : undefined;
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** True if `path` falls under any allowlisted prefix. Rejects `..` traversal. */
export function matchWriteAllowed(path: string, allowlist: string[]): boolean {
  if (!path) return false;
  const np = normalizePath(path);
  if (np.split("/").includes("..")) return false;
  return allowlist
    .map((a) => normalizePath(a.trim()).replace(/\/+$/, ""))
    .filter(Boolean)
    .some((prefix) => np === prefix || np.startsWith(prefix + "/"));
}

const MUTATING_BASH = [
  />>?/,
  /\b(rm|mv|cp|mkdir|rmdir|touch|tee|truncate|dd|ln)\b/,
  /\bsed\b[^\n]*\s-i/,
  /\bgit\b[^\n]*\b(commit|checkout|reset|merge|rebase|apply|stash|clean|restore)\b/,
  /\b(npm|pnpm|yarn|bun)\b[^\n]*\b(install|add|i|ci|remove|rm)\b/,
];

export function isMutatingBash(command: string): boolean {
  return MUTATING_BASH.some((re) => re.test(command));
}

/** True if `p` resolves inside `cwd`（处理相对路径、`..` 逃逸、分隔符）。用于「请求批准」越界写判定。 */
export function isUnderCwd(p: string, cwd: string): boolean {
  const base = resolve(cwd);
  const target = resolve(cwd, p);
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
}
