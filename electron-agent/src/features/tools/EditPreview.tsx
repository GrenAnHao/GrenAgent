import { Flexbox } from '@lobehub/ui';
import { useMemo, useState, type ReactNode } from 'react';
import { CodeSurface } from '../chat/conv/CodeSurface';
import { LazySyntaxHighlighter } from './LazyHighlighter';
import { cardStyles } from './cardStyles';
import { fileNameFromPath, langByPath } from './toolUtils';

type EditRow = { line: number | string; marker: ' ' | '+' | '-'; text: string };

export interface EditPreviewProps {
  path: string;
  diff?: string;
  oldText?: string;
  newText?: string;
  resultText?: string;
  isError?: boolean;
}

function parseRows(diff: string): EditRow[] {
  const lines = diff.split(/\r?\n/);
  const displayRows = lines.map((line) => {
    const match = line.match(/^([ +\-])(\s*\d+|\s+)\s(.*)$/);
    if (!match) return null;
    return {
      line: match[2].trim(),
      marker: match[1] as EditRow['marker'],
      text: match[3],
    };
  });
  if (displayRows.every((row) => row !== null)) return displayRows as EditRow[];

  const rows: EditRow[] = [];
  let oldLine = 1;
  let newLine = 1;
  let hasHunk = false;
  for (const line of lines) {
    const hunk = line.match(/^@@ -(\d+)/);
    if (hunk) {
      const added = line.match(/\+([0-9]+)/);
      oldLine = Number(hunk[1]);
      newLine = added ? Number(added[1]) : oldLine;
      hasHunk = true;
      continue;
    }
    if (!hasHunk || /^(---|\+\+\+)/.test(line)) continue;
    const marker = line[0] === '+' || line[0] === '-' ? line[0] : ' ';
    const text = marker === ' ' ? line.slice(1) : line.slice(1);
    if (marker === '-') rows.push({ line: oldLine++, marker, text });
    else if (marker === '+') rows.push({ line: newLine++, marker, text });
    else rows.push({ line: newLine++, marker, text }), oldLine++;
  }
  return rows;
}

function contextualRows(rows: EditRow[], context = 5): EditRow[] {
  const changed = rows.flatMap((row, index) => (row.marker === ' ' ? [] : [index]));
  if (!changed.length || rows.length <= context * 2 + 1) return rows;
  const keep = new Set<number>();
  for (const index of changed) {
    for (let i = Math.max(0, index - context); i <= Math.min(rows.length - 1, index + context); i += 1) keep.add(i);
  }
  return rows.filter((_, index) => keep.has(index));
}

function renderRows(rows: EditRow[], language: string): ReactNode {
  return (
    <div className={cardStyles.editRows}>
      <div aria-hidden className={cardStyles.editBackgrounds}>
        {rows.map((row, index) => (
          <span
            className={row.marker === '+' ? cardStyles.editAdded : row.marker === '-' ? cardStyles.editRemoved : undefined}
            key={`${row.line}-${row.marker}-${index}`}
          />
        ))}
      </div>
      <div className={cardStyles.editGutter}>
        {rows.map((row, index) => (
          <div className={cardStyles.editGutterRow} key={`${row.line}-${row.marker}-${index}`}>
            <span className={cardStyles.editLineNumber}>{row.line}</span>
            <span className={cardStyles.editMarker}>{row.marker === ' ' ? '·' : row.marker}</span>
          </div>
        ))}
      </div>
      <div className={cardStyles.editCodeText}>
        <LazySyntaxHighlighter language={language} variant="borderless">
          {rows.map((row) => row.text).join('\n')}
        </LazySyntaxHighlighter>
      </div>
    </div>
  );
}

export function EditPreview({ path, diff, oldText, newText, resultText, isError }: EditPreviewProps) {
  const [full, setFull] = useState(false);
  const language = langByPath(path);
  const rows = useMemo(() => {
    if (diff) return parseRows(diff);
    if (oldText || newText) {
      return [
        ...(oldText ? oldText.split(/\r?\n/).map((text) => ({ line: '', marker: '-' as const, text })) : []),
        ...(newText ? newText.split(/\r?\n/).map((text) => ({ line: '', marker: '+' as const, text })) : []),
      ];
    }
    return [];
  }, [diff, oldText, newText]);
  const visibleRows = full ? rows : contextualRows(rows);
  const fileName = fileNameFromPath(path);
  const noChange = /replacements? produced identical content/i.test(resultText ?? '');

  return (
    <Flexbox gap={8}>
      {path && <div className={cardStyles.pathLabel} data-tooltip={path} aria-label={path}>{fileName}</div>}
      {(isError || noChange) && resultText ? <CodeSurface isError>{resultText}</CodeSurface> : rows.length ? (
        <div className={cardStyles.editCard}>
          <div className={cardStyles.editToolbar}>
            <span>修改上下文 · {language === 'plaintext' ? '文本' : language}</span>
            {contextualRows(rows).length < rows.length ? (
              <button type="button" onClick={() => setFull((value) => !value)}>{full ? '修改上下文' : '全部修改'}</button>
            ) : null}
          </div>
          <div className={cardStyles.editScroll} data-testid="edit-preview-scroll">
            <div data-testid="edit-preview-language" data-language={language}>{renderRows(visibleRows, language)}</div>
          </div>
        </div>
      ) : <CodeSurface isError={isError}>{resultText || '未生成修改预览'}</CodeSurface>}
    </Flexbox>
  );
}
