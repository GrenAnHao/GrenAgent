import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function statePath(cwd: string, sessionId: string): string {
  return join(cwd, ".pi", "session-state", `${sessionId}.md`);
}

export function writeState(path: string, md: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, md, "utf8");
}

export function readState(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** 第一行的分支锚点：写入开始时分支最后一条条目（叶子）的 id。 */
const ANCHOR_LINE = /^<!-- session-state anchor=(\S+) -->\r?\n/;

export interface StateDoc {
  body: string;
  anchor?: string;
}

export function readStateDoc(path: string): StateDoc | undefined {
  const raw = readState(path);
  if (raw == null) return undefined;
  const m = ANCHOR_LINE.exec(raw);
  return m ? { body: raw.slice(m[0].length), anchor: m[1] } : { body: raw };
}

export function writeStateDoc(path: string, body: string, anchor: string | undefined): void {
  writeState(path, anchor ? `<!-- session-state anchor=${anchor} -->\n${body}` : body);
}

/** 状态属于当前分支时返回正文：锚点存在、出现在分支条目 id 里、正文非空。没有锚点的旧文件不用。 */
export function stateOnBranch(
  doc: StateDoc | undefined,
  branch: readonly { id?: string }[],
): string | undefined {
  if (!doc?.anchor || !doc.body.trim()) return undefined;
  return branch.some((e) => e?.id === doc.anchor) ? doc.body : undefined;
}
