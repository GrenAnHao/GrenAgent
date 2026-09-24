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

export interface CodeSearchMatch {
  line: number;
  text: string;
}

export interface CodeSearchFile {
  path: string;
  matches: CodeSearchMatch[];
}

export interface CodeSearchView {
  files: CodeSearchFile[];
  total: number;
  capped: boolean;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 解析 batch-tools `search` 的结果：优先 details.matches，否则解析文本分组。 */
export function parseCodeSearch(text: string, details?: Record<string, unknown>): CodeSearchView {
  if (details && Array.isArray(details.matches)) {
    const files: CodeSearchFile[] = [];
    const index = new Map<string, CodeSearchFile>();
    for (const item of details.matches) {
      if (!isRecord(item) || typeof item.file !== 'string' || !item.file) continue;
      let file = index.get(item.file);
      if (!file) {
        file = { path: item.file, matches: [] };
        index.set(item.file, file);
        files.push(file);
      }
      file.matches.push({
        line: typeof item.line === 'number' ? item.line : 0,
        text: typeof item.text === 'string' ? item.text : '',
      });
    }
    const total =
      typeof details.total === 'number' ? details.total : files.reduce((n, file) => n + file.matches.length, 0);
    const error = files.length === 0 && text.startsWith('search:') ? text : undefined;
    return { files, total, capped: details.capped === true, error };
  }
  return parseCodeSearchText(text);
}

function parseCodeSearchText(text: string): CodeSearchView {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('No matches')) {
    return { files: [], total: 0, capped: false };
  }
  if (trimmed.startsWith('search:')) {
    return { files: [], total: 0, capped: false, error: trimmed };
  }

  const files: CodeSearchFile[] = [];
  let current: CodeSearchFile | null = null;
  let total = 0;
  let capped = false;
  for (const raw of text.split('\n')) {
    const footer = raw.match(/^\((\d+) matches in \d+ files(.*)\)$/);
    if (footer) {
      total = Number(footer[1]);
      capped = /capped/i.test(footer[2] ?? '');
      continue;
    }
    const hit = raw.match(/^ {2}(\d+): (.*)$/);
    if (hit) {
      current?.matches.push({ line: Number(hit[1]), text: hit[2] });
      continue;
    }
    if (!raw.trim() || raw.startsWith(' ')) continue;
    current = { path: raw, matches: [] };
    files.push(current);
  }

  const withHits = files.filter((file) => file.matches.length > 0);
  if (total === 0) total = withHits.reduce((n, file) => n + file.matches.length, 0);
  return { files: withHits, total, capped };
}
