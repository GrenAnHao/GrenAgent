// hashline 补丁解析器（行级子集）。把模型产出的补丁文本解析为按文件分段的操作列表。
// 语法见 prompt.ts；.BLK（tree-sitter 块操作）属二期，这里显式拒绝并提示用行级操作。
// 纯逻辑、无 I/O，便于单测。

export type Op =
  | { kind: "swap"; start: number; end: number; body: string[] }
  | { kind: "del"; start: number; end: number }
  | { kind: "insPre"; line: number; body: string[] }
  | { kind: "insPost"; line: number; body: string[] }
  | { kind: "insHead"; body: string[] }
  | { kind: "insTail"; body: string[] };

export interface FileSection {
  path: string;
  tag: string;
  ops: Op[];
}

export interface ParseResult {
  sections: FileSection[];
  error?: string;
}

const HEADER_RE = /^\[(.+?)#([0-9a-fA-F]{1,8})\]$/;

// 把补丁文本解析成文件段。任一行非法即整体失败（返回 error + 已解析的部分供诊断）。
export function parsePatch(text: string): ParseResult {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const sections: FileSection[] = [];
  let cur: FileSection | null = null;
  let pendingBody: string[] | null = null;

  const fail = (i: number, msg: string): ParseResult => ({ sections, error: `第 ${i + 1} 行：${msg}` });

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // body 行：以 '+' 开头，去掉首个 '+' 即字面内容（'+' 单独=空行，'++x'→'+x'，'+-x'→'-x'）。
    if (raw.startsWith("+")) {
      if (!pendingBody) return fail(i, "出现 body 行（+...）但上方没有带 ':' 的操作");
      pendingBody.push(raw.slice(1));
      continue;
    }

    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") {
      pendingBody = null; // 空行结束 body 收集
      continue;
    }

    const header = line.match(HEADER_RE);
    if (header) {
      if (cur) sections.push(cur);
      cur = { path: header[1].trim(), tag: header[2].toLowerCase(), ops: [] };
      pendingBody = null;
      continue;
    }

    if (!cur) return fail(i, "操作出现在 [PATH#TAG] 文件头之前");
    pendingBody = null;

    if (/^(SWAP|DEL|INS)\.BLK/.test(line)) {
      return fail(i, ".BLK 块操作暂未支持（请用行级 SWAP/DEL/INS）");
    }

    let m: RegExpMatchArray | null;
    if ((m = line.match(/^SWAP\s+(\d+)\.=(\d+):$/))) {
      const op: Op = { kind: "swap", start: Number(m[1]), end: Number(m[2]), body: [] };
      cur.ops.push(op);
      pendingBody = op.body;
      continue;
    }
    if ((m = line.match(/^SWAP\s+(\d+):$/))) {
      const start = Number(m[1]);
      const op: Op = { kind: "swap", start, end: start, body: [] };
      cur.ops.push(op);
      pendingBody = op.body;
      continue;
    }
    if ((m = line.match(/^DEL\s+(\d+)\.=(\d+)$/))) {
      cur.ops.push({ kind: "del", start: Number(m[1]), end: Number(m[2]) });
      continue;
    }
    if ((m = line.match(/^DEL\s+(\d+)$/))) {
      cur.ops.push({ kind: "del", start: Number(m[1]), end: Number(m[1]) });
      continue;
    }
    if ((m = line.match(/^INS\.(PRE|POST)\s+(\d+):$/))) {
      const op: Op =
        m[1] === "PRE"
          ? { kind: "insPre", line: Number(m[2]), body: [] }
          : { kind: "insPost", line: Number(m[2]), body: [] };
      cur.ops.push(op);
      pendingBody = op.body;
      continue;
    }
    if ((m = line.match(/^INS\.(HEAD|TAIL):$/))) {
      const op: Op = m[1] === "HEAD" ? { kind: "insHead", body: [] } : { kind: "insTail", body: [] };
      cur.ops.push(op);
      pendingBody = op.body;
      continue;
    }
    return fail(i, `无法识别的操作：${line}`);
  }

  if (cur) sections.push(cur);
  if (sections.length === 0) return { sections, error: "未解析到任何 [PATH#TAG] 文件段" };
  return { sections };
}
