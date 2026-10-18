import type { CodeTool } from '../../lib/agentData';
import type { CodeRetrievalRow } from '../../../electron/agentData/codeRetrievalResult';

/** 结果列表一页的大小：文件列表向主进程要这么多，其余结果在前端按这个切页。 */
export const CODE_PAGE_SIZE = 100;

export type CodeResultRow = CodeRetrievalRow;
export interface CodeResultView {
  rows: CodeResultRow[];
  text?: string;
  raw: unknown;
  isError: boolean;
  recognition: 'rows' | 'text' | 'unknown';
  message?: string;
  /** 分页结果才有：本页从第几项开始、过滤后一共多少项。 */
  page?: { offset: number; total: number };
}

/** 把下一页并到已加载的行后面；总数和原始结果取最新一页的。 */
export function appendCodeResultPage(base: CodeResultView, next: CodeResultView): CodeResultView {
  return { ...base, rows: [...base.rows, ...next.rows], raw: next.raw, page: next.page, message: next.message ?? base.message };
}

/** A failed MCP response is still rendered in full, alongside the last successful content. */
export function retainedCodeResult(next: CodeResultView, current?: CodeResultView, retained?: CodeResultView): CodeResultView | undefined {
  if (!next.isError) return undefined;
  return current?.isError ? retained : current;
}

export function decodeCodeResult(_tool: CodeTool, raw: unknown): CodeResultView {
  const envelope = asObject(raw);
  let text: string | undefined;
  if (typeof raw === 'string') text = raw;
  else if (Array.isArray(envelope?.content)) {
    text = envelope.content.flatMap((block) => {
      const entry = asObject(block);
      return entry?.type === 'text' && typeof entry.text === 'string' ? [entry.text] : [];
    }).join('\n');
  }
  const base: CodeResultView = { rows: [], raw, isError: envelope?.isError === true, recognition: text ? 'text' : 'unknown', ...(text ? { text } : {}) };
  const structured = Array.isArray(raw) ? raw : envelope?.structuredContent;
  const sdk = asObject(structured);
  if (sdk?.schemaVersion === 1 && Array.isArray(sdk.rows)) {
    const decoded = decodeRows(sdk.rows);
    const page = readPage(sdk.extra);
    if (decoded) return { ...base, ...decoded, ...(page ? { page } : {}), recognition: 'rows' };
  }
  if (Array.isArray(structured)) {
    const decoded = decodeRows(structured);
    if (decoded) return { ...base, ...decoded, recognition: 'rows' };
  }
  if (text) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { /* Plain MCP text is also a valid readable result. */ }
    if (Array.isArray(parsed)) {
      const decoded = decodeRows(parsed);
      if (decoded) return { ...base, ...decoded, recognition: 'rows' };
    }
  }
  return base;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function decodeRows(values: unknown[]): Pick<CodeResultView, 'rows' | 'message'> | undefined {
  const rows = values.flatMap((value): CodeResultRow[] => {
    const entry = asObject(value);
    if (!entry) return [];
    const file = stringValue(entry.file) ?? stringValue(entry.path);
    const symbol = stringValue(entry.symbol) ?? stringValue(entry.name);
    if (!file && !symbol) return [];
    return [{
      ...(file ? { file } : {}), ...(symbol ? { symbol } : {}),
      ...(stringValue(entry.id) ? { id: stringValue(entry.id) } : {}),
      ...(stringValue(entry.kind) ? { kind: stringValue(entry.kind) } : {}),
      ...(typeof entry.line === 'number' && Number.isInteger(entry.line) && entry.line > 0 ? { line: entry.line } : {}),
      ...(typeof entry.endLine === 'number' && Number.isInteger(entry.endLine) && entry.endLine > 0 ? { endLine: entry.endLine } : {}),
      ...(typeof entry.snippet === 'string' ? { snippet: entry.snippet } : {}),
    }];
  });
  if (values.length && !rows.length) return undefined;
  return { rows, ...(rows.length !== values.length ? { message: '部分条目未识别，完整内容见原始结果。' } : {}) };
}

function readPage(extra: unknown): CodeResultView['page'] {
  const page = asObject(asObject(extra)?.page);
  const offset = page?.offset;
  const total = page?.total;
  if (typeof offset !== 'number' || typeof total !== 'number') return undefined;
  return Number.isSafeInteger(offset) && Number.isSafeInteger(total) && offset >= 0 && total >= 0 ? { offset, total } : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
