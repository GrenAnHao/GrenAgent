import { resolve, sep } from "node:path";

const DANGEROUS_BASH = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive)/i,
  // rm 的递归+强制拆成两个参数：rm -r -f / PowerShell rm -r -Force
  /\brm\b(?=(?:[^\n]*\s)(?:-[a-z]*r[a-z]*|--recursive)(?:\s|$))(?=(?:[^\n]*\s)(?:-[a-z]*f[a-z]*|--force)(?:\s|$))/i,
  /\bsudo\b/i,
  /\b(chmod|chown)\b[^\n]*\b777\b/i,
  /\bmkfs\b/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, // fork bomb
  />\s*\/dev\/sd[a-z]/i,
  /\bdd\b/i,
  /\bgit\b[^\n]*\breset\b[^\n]*--hard\b/i,
  /\bgit\b[^\n]*\bpush\b[^\n]*(?:--force(?:-with-lease)?\b|\s-f\b)/i,
  /\bkill\b[^\n]*(?:-9\b|-kill\b|-sigkill\b)/i,
  /\|\s*(?:sudo\s+)?(?:(?:ba)?sh|zsh|dash|ksh|fish|pwsh|powershell)\b/i,
  /\bRemove-Item\b[^\n]*-(?:Recurse|r)\b/i,
  /\b(?:rd|rmdir)\b[^\n]*\/s\b/i,
  /\b(?:shutdown|reboot|halt|poweroff)\b/i,
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
  /\b(rm|mv|cp|mkdir|rmdir|touch|tee|truncate|dd|ln)\b/,
  /\bsed\b[^\n]*\s-i/,
  /\bgit\b[^\n]*\b(commit|checkout|reset|merge|rebase|apply|stash|clean|restore)\b/,
  /\b(npm|pnpm|yarn|bun)\b[^\n]*\b(install|add|i|ci|remove|rm)\b/,
];

/** 去掉引号内容，避免把 `rg "=>"` 里的 `>` 当成重定向。 */
function stripQuoted(command: string): string {
  return command.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, " ");
}

/**
 * 真正写文件的重定向：`> file` / `>> file` / `2> file`。
 * `2>&1` 只是 fd 复制，`=>` 是搜索模式，都不能算改盘。
 */
function hasFileRedirect(command: string): boolean {
  const withoutFdDup = stripQuoted(command).replace(/\d*>&\d+/g, " ");
  return /(?<![=>])>{1,2}(?!&)/.test(withoutFdDup);
}

export function isMutatingBash(command: string): boolean {
  return hasFileRedirect(command) || MUTATING_BASH.some((re) => re.test(command));
}

/** True if `p` resolves inside `cwd`（处理相对路径、`..` 逃逸、分隔符）。用于「请求批准」越界写判定。 */
export function isUnderCwd(p: string, cwd: string): boolean {
  const base = resolve(cwd);
  const target = resolve(cwd, p);
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
}
