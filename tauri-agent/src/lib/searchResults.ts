export interface GrepMatch {
  line: number;
  text: string;
}
export interface GrepFile {
  path: string;
  matches: GrepMatch[];
}
export interface GrepResult {
  total: number;
  truncated: boolean;
  files: GrepFile[];
}

/**
 * 解析内置 grep 工具的文本输出（opencode 格式，与 Pi 同源）：
 *   Found N matches[ (showing first 100)]
 *   <path>:
 *     Line 12: <text>
 *     Line 30: <text>
 *
 *   <path2>:
 *     Line 5: <text>
 *   (Results truncated: ...)         // 可选
 *   (Some paths were inaccessible)   // 可选
 */
export function parseGrepOutput(text: string): GrepResult {
  const files: GrepFile[] = [];
  let total = 0;
  let truncated = false;
  let current: GrepFile | null = null;

  for (const raw of text.split('\n')) {
    const found = raw.match(/^Found (\d+) matches?/);
    if (found) {
      total = Number(found[1]);
      if (/showing first/i.test(raw)) truncated = true;
      continue;
    }
    if (raw.startsWith('(')) {
      if (/truncated/i.test(raw)) truncated = true;
      continue;
    }
    const m = raw.match(/^\s+Line (\d+): ?(.*)$/);
    if (m) {
      if (current) current.matches.push({ line: Number(m[1]), text: m[2] });
      continue;
    }
    if (raw.endsWith(':') && raw.trim().length > 1 && !raw.startsWith(' ')) {
      current = { path: raw.slice(0, -1), matches: [] };
      files.push(current);
    }
  }

  // 文本没给「Found N」时（兜底）用实际命中行数。
  if (total === 0) total = files.reduce((n, f) => n + f.matches.length, 0);
  return { total, truncated, files };
}

export interface GlobResult {
  files: string[];
  truncated: boolean;
}

/** 解析 glob 工具输出：逐行文件路径（绝对路径），可能带 "No files found" 或截断提示。 */
export function parseGlobOutput(text: string): GlobResult {
  const files: string[] = [];
  let truncated = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('(')) {
      if (/truncated/i.test(line)) truncated = true;
      continue;
    }
    if (line === 'No files found') continue;
    files.push(line);
  }
  return { files, truncated };
}
