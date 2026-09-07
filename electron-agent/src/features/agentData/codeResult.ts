import type { CodeTool } from '../../lib/agentData';
import type { CodeRetrievalRow } from '../../../electron/agentData/codeRetrievalResult';

export type CodeResultRow = CodeRetrievalRow;
export interface CodeResultView {
  rows: CodeResultRow[];
  text?: string;
  raw: unknown;
  isError: boolean;
  recognition: 'rows' | 'text' | 'unknown';
  message?: string;
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
    if (decoded) return { ...base, ...decoded, recognition: 'rows' };
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

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
