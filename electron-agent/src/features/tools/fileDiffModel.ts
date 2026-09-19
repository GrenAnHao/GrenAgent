import { extractText, getDiff, getEditTexts } from './toolUtils';

export type DiffMarker = '+' | '-' | ' ';
export interface DiffRow { marker: DiffMarker; text: string }
export interface FileDiff { path: string; rows: DiffRow[]; added: number; deleted: number }

const READ = new Set(['read', 'read_file']);
const WRITE = new Set(['write', 'write_file']);
const EDIT = new Set(['edit', 'search_replace', 'str_replace']);

export function isFileRead(name: string): boolean {
  return READ.has(name.toLowerCase());
}
export function isFileMutation(name: string): boolean {
  const lower = name.toLowerCase();
  return WRITE.has(lower) || EDIT.has(lower);
}

export function fileCardVerb(name: string): '读取' | '写入' | '编辑' | null {
  const lower = name.toLowerCase();
  if (READ.has(lower)) return '读取';
  if (WRITE.has(lower)) return '写入';
  if (EDIT.has(lower)) return '编辑';
  return null;
}

export function mutationPath(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const input = args as Record<string, unknown>;
  for (const key of ['path', 'file_path']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

export function contentLines(text: string): string[] {
  if (text === '') return [];
  return text.replace(/(?:\r?\n)+$/u, '').split(/\r?\n/);
}

function totals(rows: DiffRow[]): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const row of rows) {
    if (row.marker === '+') added += 1;
    if (row.marker === '-') deleted += 1;
  }
  return { added, deleted };
}

function lcsRows(prev: string[], next: string[]): DiffRow[] {
  const n = prev.length;
  const m = next.length;
  if (n + m > 256) {
    return [
      ...prev.map((text) => ({ marker: '-' as const, text })),
      ...next.map((text) => ({ marker: '+' as const, text })),
    ];
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = prev[i] === next[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (prev[i] === next[j]) {
      rows.push({ marker: ' ', text: prev[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ marker: '-', text: prev[i] });
      i += 1;
    } else {
      rows.push({ marker: '+', text: next[j] });
      j += 1;
    }
  }
  while (i < n) {
    rows.push({ marker: '-', text: prev[i] });
    i += 1;
  }
  while (j < m) {
    rows.push({ marker: '+', text: next[j] });
    j += 1;
  }
  return rows;
}

export function rowsFromTexts(oldText: string | null, newText: string): DiffRow[] {
  const next = contentLines(newText);
  if (oldText === null) return next.map((text) => ({ marker: '+', text }));
  return lcsRows(contentLines(oldText), next);
}

function parsePiDisplayDiff(diff: string): DiffRow[] | null {
  const lines = diff.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  const rows: DiffRow[] = [];
  for (const line of lines) {
    if (line.startsWith('@@')) continue;
    const match = line.match(/^([ +\-])(?:\s*\d+|\s+)\s(.*)$/);
    if (!match) return null;
    const marker = match[1] === '+' || match[1] === '-' ? match[1] : ' ';
    rows.push({ marker, text: match[2] });
  }
  return rows.length ? rows : null;
}

function parseUnifiedDiff(diff: string): DiffRow[] | null {
  const rows: DiffRow[] = [];
  for (const line of diff.split(/\r?\n/)) {
    if (!line || line.startsWith('@@') || line.startsWith('diff') || line.startsWith('index') || line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('+')) rows.push({ marker: '+', text: line.slice(1) });
    else if (line.startsWith('-')) rows.push({ marker: '-', text: line.slice(1) });
    else if (line.startsWith(' ')) rows.push({ marker: ' ', text: line.slice(1) });
    else return null;
  }
  return rows.length ? rows : null;
}

function rowsFromApplied(diff: string): DiffRow[] | null {
  return parsePiDisplayDiff(diff) ?? parseUnifiedDiff(diff);
}

function identicalContent(result: unknown): boolean {
  return /replacements? produced identical content/i.test(extractText(result));
}

export function fileDiffModel(
  toolName: string,
  args: unknown,
  result: unknown,
  status: 'running' | 'done' | 'error',
): FileDiff | null {
  if (!isFileMutation(toolName) || status === 'error' || identicalContent(result)) return null;
  const path = mutationPath(args);
  if (!path) return null;
  const applied = status === 'done' ? getDiff(result) : undefined;
  const rows = applied ? rowsFromApplied(applied) : null;
  if (rows) return { path, rows, ...totals(rows) };
  const lower = toolName.toLowerCase();
  if (WRITE.has(lower)) {
    const content = typeof (args as { content?: unknown } | null)?.content === 'string'
      ? (args as { content: string }).content
      : '';
    const intended = rowsFromTexts(null, content);
    return { path, rows: intended, ...totals(intended) };
  }
  const { oldText, newText } = getEditTexts(args);
  const intended = rowsFromTexts(oldText, newText);
  return { path, rows: intended, ...totals(intended) };
}
