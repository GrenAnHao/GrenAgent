import { readFileSync, writeFileSync } from "node:fs";
import { type SgNode, parse } from "@ast-grep/napi";
import { type CoreLang, collectFiles } from "./lang.js";
import { type MetaResolver, expandTemplate } from "./rewrite.js";

export interface AstEditOp {
  pat: string;
  out: string;
}
export interface AstEditFileResult {
  rel: string;
  replacements: number;
}
export interface AstEditResult {
  files: AstEditFileResult[];
  totalReplacements: number;
  filesSearched: number;
  applied: boolean;
  parseErrors: string[];
}
export interface AstEditArgs {
  ops: AstEditOp[];
  paths: string[];
  dryRun: boolean;
  cwd: string;
}

function buildResolver(node: SgNode, source: string): MetaResolver {
  return {
    single: (name) => node.getMatch(name)?.text() ?? null,
    multi: (name) => {
      const ns = node.getMultipleMatches(name);
      if (ns.length === 0) return null;
      // $$$ 含分隔符节点，取首尾 range 切片以保留原始分隔（逗号/空格）。
      const start = ns[0].range().start.index;
      const end = ns[ns.length - 1].range().end.index;
      return source.slice(start, end);
    },
  };
}

// 在单个文件源码上串行应用所有 op（每个 op 在上一个 op 的结果上重解析），返回 {next, count}。
function applyOpsToSource(source: string, lang: CoreLang, ops: AstEditOp[]): { next: string; count: number } {
  let current = source;
  let count = 0;
  for (const op of ops) {
    const root = parse(lang, current).root();
    const nodes = root.findAll(op.pat);
    if (nodes.length === 0) continue;
    const edits = nodes.map((n) => n.replace(expandTemplate(op.out, buildResolver(n, current))));
    edits.sort((a, b) => b.startPos - a.startPos); // 逆序应用，避免偏移错位
    current = root.commitEdits(edits);
    count += nodes.length;
  }
  return { next: current, count };
}

export async function runAstEdit(args: AstEditArgs): Promise<AstEditResult> {
  const files = await collectFiles(args.paths, args.cwd);
  const results: AstEditFileResult[] = [];
  const parseErrors: string[] = [];
  let total = 0;
  for (const f of files) {
    let src: string;
    try {
      src = readFileSync(f.abs, "utf8");
    } catch (err) {
      parseErrors.push(`${f.rel}: read failed ${(err as Error).message}`);
      continue;
    }
    let outcome: { next: string; count: number };
    try {
      outcome = applyOpsToSource(src, f.lang, args.ops);
    } catch (err) {
      parseErrors.push(`${f.rel}: ${(err as Error).message}`);
      continue;
    }
    if (outcome.count === 0) continue;
    if (!args.dryRun && outcome.next !== src) {
      try {
        writeFileSync(f.abs, outcome.next, "utf8");
      } catch (err) {
        parseErrors.push(`${f.rel}: write failed ${(err as Error).message}`);
        continue;
      }
    }
    results.push({ rel: f.rel, replacements: outcome.count });
    total += outcome.count;
  }
  return { files: results, totalReplacements: total, filesSearched: files.length, applied: !args.dryRun, parseErrors };
}
