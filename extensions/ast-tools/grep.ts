import { readFileSync } from "node:fs";
import { parse } from "@ast-grep/napi";
import { collectFiles } from "./lang.js";

export interface AstGrepMatch {
  rel: string;
  line: number; // 1-based
  column: number; // 1-based
  text: string;
}
export interface AstGrepResult {
  matches: AstGrepMatch[];
  totalMatches: number;
  filesSearched: number;
  parseErrors: string[];
}
export interface AstGrepArgs {
  pat: string;
  paths: string[];
  skip: number;
  cwd: string;
  limit?: number; // 默认 200
}

export async function runAstGrep(args: AstGrepArgs): Promise<AstGrepResult> {
  const limit = args.limit ?? 200;
  const files = await collectFiles(args.paths, args.cwd);
  const all: AstGrepMatch[] = [];
  const parseErrors: string[] = [];
  for (const f of files) {
    let src: string;
    try {
      src = readFileSync(f.abs, "utf8");
    } catch (err) {
      parseErrors.push(`${f.rel}: read failed ${(err as Error).message}`);
      continue;
    }
    try {
      const nodes = parse(f.lang, src).root().findAll(args.pat);
      for (const n of nodes) {
        const r = n.range();
        all.push({ rel: f.rel, line: r.start.line + 1, column: r.start.column + 1, text: n.text() });
      }
    } catch (err) {
      parseErrors.push(`${f.rel}: ${(err as Error).message}`);
    }
  }
  all.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line || a.column - b.column);
  const visible = all.slice(args.skip, args.skip + limit);
  return { matches: visible, totalMatches: all.length, filesSearched: files.length, parseErrors };
}
