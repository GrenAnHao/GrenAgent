// 行级 applier。所有行号指原始文件（1-based，应用过程中不偏移——与 hashline 语义一致）。
// swap/del 区间不可重叠；越界即报错。重建顺序：HEAD → 逐行(insPre → 原行 或 swap body → insPost) → TAIL。
import type { Op } from "./parser.js";

export interface ApplyResult {
  content?: string;
  error?: string;
}

export function applyOps(content: string, ops: Op[]): ApplyResult {
  const lines = content.split("\n");
  const n = lines.length;
  const removed = new Array<boolean>(n + 1).fill(false);
  const swapBody = new Map<number, string[]>();
  const insPre = new Map<number, string[]>();
  const insPost = new Map<number, string[]>();
  const head: string[] = [];
  const tail: string[] = [];

  for (const op of ops) {
    if (op.kind === "insHead") {
      head.push(...op.body);
      continue;
    }
    if (op.kind === "insTail") {
      tail.push(...op.body);
      continue;
    }
    if (op.kind === "insPre" || op.kind === "insPost") {
      if (op.line < 1 || op.line > n) return { error: `INS 行号越界：${op.line}（文件共 ${n} 行）` };
      const map = op.kind === "insPre" ? insPre : insPost;
      map.set(op.line, (map.get(op.line) ?? []).concat(op.body));
      continue;
    }
    // swap / del
    if (op.start < 1 || op.end > n || op.start > op.end) {
      return { error: `区间越界：${op.start}.=${op.end}（文件共 ${n} 行）` };
    }
    for (let i = op.start; i <= op.end; i++) {
      if (removed[i]) return { error: `区间在第 ${i} 行重叠（一个范围只能被一个操作覆盖）` };
      removed[i] = true;
    }
    if (op.kind === "swap") swapBody.set(op.start, op.body);
  }

  const out: string[] = [...head];
  for (let i = 1; i <= n; i++) {
    const pre = insPre.get(i);
    if (pre) out.push(...pre);
    if (removed[i]) {
      const body = swapBody.get(i);
      if (body) out.push(...body);
    } else {
      out.push(lines[i - 1]);
    }
    const post = insPost.get(i);
    if (post) out.push(...post);
  }
  out.push(...tail);
  return { content: out.join("\n") };
}
