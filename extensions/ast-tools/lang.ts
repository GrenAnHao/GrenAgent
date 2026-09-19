// ast-grep 核心包（@ast-grep/napi@0.43）内置语言：Html / JavaScript / Tsx / Css / TypeScript。
// 这些值是 parse(lang, src) 接受的语言字符串（Lang enum 运行时为空，故用字面量）。
// 其他语言（python/go/rust/...）需 registerDynamicLanguage + tree-sitter 动态库，列为后续增强。
import { statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { glob } from "tinyglobby";
import { SKIP_DIRS } from "../_shared/fs-walk.js";
import { listFilesWithRg } from "../_shared/ripgrep.js";

export type CoreLang = "JavaScript" | "TypeScript" | "Tsx" | "Css" | "Html";

const EXT_TO_LANG: Record<string, CoreLang> = {
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  ts: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  tsx: "Tsx",
  css: "Css",
  html: "Html",
  htm: "Html",
};

const GLOB_IGNORE = [...SKIP_DIRS].map((d) => `**/${d}/**`);

export function extToLang(filename: string): CoreLang | null {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = filename.slice(dot + 1).toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}

export interface CollectedFile {
  abs: string;
  rel: string;
  lang: CoreLang;
}

// 把一个 path 规范成 tinyglobby pattern：目录→ dir/**/*，文件/glob 原样（POSIX 斜杠）。
function toPattern(p: string, cwd: string): string {
  const hasGlob = /[*?[\]{}]/.test(p);
  if (!hasGlob) {
    const abs = isAbsolute(p) ? p : resolve(cwd, p);
    try {
      if (statSync(abs).isDirectory()) return `${p.replace(/\\/g, "/").replace(/\/$/, "")}/**/*`;
    } catch {
      // 不存在就当普通模式交给 glob（返回空）
    }
  }
  return p.replace(/\\/g, "/");
}

function toCollected(absPaths: string[], cwd: string): CollectedFile[] {
  const out: CollectedFile[] = [];
  const seen = new Set<string>();
  for (const abs of absPaths) {
    const norm = abs.replace(/\\/g, "/");
    if (seen.has(norm)) continue;
    seen.add(norm);
    const lang = extToLang(abs);
    if (lang === null) continue;
    out.push({ abs, rel: relative(cwd, abs).replace(/\\/g, "/"), lang });
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

export async function collectFiles(paths: string[], cwd: string): Promise<CollectedFile[]> {
  const listed = await listFilesWithRg({ cwd, targets: paths });
  if (listed) return toCollected(listed, cwd);
  const patterns = paths.map((p) => toPattern(p, cwd));
  const hits = await glob(patterns, { cwd, absolute: true, onlyFiles: true, dot: false, ignore: GLOB_IGNORE });
  return toCollected(hits, cwd);
}
