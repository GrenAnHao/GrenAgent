// 文件枚举 + 轻量 glob->regex。目录跳过 + 递归遍历复用 _shared/fs-walk.ts，
// 这里额外支持 glob 过滤、单文件字节上限与枚举上限。无外部依赖、跨平台。
import { statSync } from "node:fs";
import { relative, sep } from "node:path";
import { walkDir } from "../_shared/fs-walk.js";

/** glob -> RegExp：`*`=单段、`**`=任意层(可零，吃掉随后的 /)、`?`=单个非斜杠字符；其余正则元字符转义。匹配相对 POSIX 路径。 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

/** 任一 glob 命中即真；无 glob 视为全通过。先把分隔符归一化为 /。 */
export function matchesAnyGlob(relPath: string, globs: RegExp[]): boolean {
  if (!globs.length) return true;
  const p = relPath.split(sep).join("/").split("\\").join("/");
  return globs.some((g) => g.test(p));
}

/** 跳过单行巨型产物：tsbuildinfo / source map / 压缩 bundle。DSH 靠 gitignore+rg；我们用扩展名兜底。 */
export function isSkippedSearchFile(path: string): boolean {
  const lower = path.replace(/\\/g, "/").toLowerCase();
  return (
    lower.endsWith(".tsbuildinfo") ||
    lower.endsWith(".map") ||
    lower.endsWith(".min.js") ||
    lower.endsWith(".min.css") ||
    lower.endsWith(".min.mjs")
  );
}

/** 递归枚举 root 下文件（glob 过滤、跳过 SKIP_DIRS/隐藏目录、文件数与单文件字节上限）。 */
export function walkFiles(
  root: string,
  opts: { globs?: string[]; maxFiles?: number; maxFileBytes?: number } = {},
): string[] {
  const maxFiles = opts.maxFiles ?? 5000;
  const maxFileBytes = opts.maxFileBytes ?? 1048576;
  const globs = (opts.globs ?? []).map(globToRegExp);
  const out: string[] = [];
  walkDir(
    root,
    (full) => {
      if (out.length >= maxFiles) return;
      if (isSkippedSearchFile(full)) return;
      if (!matchesAnyGlob(relative(root, full), globs)) return;
      try {
        if (statSync(full).size > maxFileBytes) return;
      } catch {
        return;
      }
      out.push(full);
    },
    () => out.length >= maxFiles,
  );
  return out;
}
