import { memo, useMemo } from 'react';
import type { DiffRow } from './fileDiffModel';
import { languageFromPath } from './codeLanguage';
import { LazyCodeDiff } from './LazyHighlighter';
import { CodeCard } from './CodeCard';

function withTrailingNewline(text: string): string {
  if (!text || text.endsWith('\n')) return text;
  return `${text}\n`;
}

function textsFromRows(rows: DiffRow[]): { oldContent: string; newContent: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const row of rows) {
    if (row.marker !== '+') oldLines.push(row.text);
    if (row.marker !== '-') newLines.push(row.text);
  }
  return {
    oldContent: withTrailingNewline(oldLines.join('\n')),
    newContent: withTrailingNewline(newLines.join('\n')),
  };
}

export const FileDiffBlock = memo(function FileDiffBlock({
  path,
  rows,
  added,
  deleted,
}: {
  path: string;
  rows: DiffRow[];
  added: number;
  deleted: number;
}) {
  const { oldContent, newContent } = useMemo(() => textsFromRows(rows), [rows]);
  const fileName = path.split(/[/\\]/).pop() || path;

  return (
    <div
      data-new-content={newContent}
      data-old-content={oldContent}
      data-testid="file-diff-block"
      style={{
        width: '100%',
        minWidth: 0,
        ['--diffs-font-family' as string]: 'var(--pi-font-mono)',
        ['--diffs-header-font-family' as string]: 'var(--pi-font-sans)',
      }}
    >
      <CodeCard added={added} deleted={deleted} fileName={fileName}>
        <LazyCodeDiff
          fileName={fileName}
          fullFeatured={false}
          language={languageFromPath(path)}
          newContent={newContent}
          oldContent={oldContent}
          showHeader={false}
          style={{ width: '100%' }}
          variant="borderless"
          viewMode="unified"
        />
      </CodeCard>
    </div>
  );
});
