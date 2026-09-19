import { Button, Flexbox } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback, useMemo, useState } from 'react';
import type { DiffRow } from './fileDiffModel';

export const CHAT_DIFF_MAX_LINES = 16;
const FOLD_HEAD = 6;
const FOLD_TAIL = 6;

const styles = createStaticStyles(({ css }) => ({
  root: css`
    display: flex;
    flex-direction: column;
    min-width: 0;
    max-width: 100%;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillQuaternary};
    font-family: ${cssVar.fontFamilyCode};
    font-size: 13px;
    line-height: 1.7;
    color: ${cssVar.colorText};
  `,
  toolbar: css`
    display: flex;
    justify-content: flex-end;
    padding: 4px 8px;
    border-bottom: 1px solid ${cssVar.colorBorderSecondary};
  `,
  body: css`
    overflow: auto;
    max-height: min(50vh, 360px);
    padding: 9px 12px;
    white-space: pre-wrap;
    word-break: break-word;
  `,
  line: css`
    display: block;
  `,
  added: css`
    color: ${cssVar.colorSuccess};
  `,
  removed: css`
    color: ${cssVar.colorError};
  `,
  fold: css`
    padding: 2px 0;
  `,
  footer: css`
    padding: 4px 12px;
    border-top: 1px solid ${cssVar.colorBorderSecondary};
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
}));

function formatRow(row: DiffRow): string {
  const marker = row.marker === ' ' ? ' ' : row.marker;
  return `${marker} ${row.text}`;
}

function rowClass(marker: DiffRow['marker']): string | undefined {
  if (marker === '+') return styles.added;
  if (marker === '-') return styles.removed;
  return undefined;
}

export const FileDiffBlock = memo(function FileDiffBlock({
  path: _path,
  rows,
  added,
  deleted,
}: {
  path: string;
  rows: DiffRow[];
  added: number;
  deleted: number;
}) {
  const [expanded, setExpanded] = useState(false);

  const shouldFold = rows.length > CHAT_DIFF_MAX_LINES;
  const hiddenCount = shouldFold ? rows.length - FOLD_HEAD - FOLD_TAIL : 0;

  const visibleRows = useMemo(() => {
    if (!shouldFold || expanded) return rows;
    return [...rows.slice(0, FOLD_HEAD), ...rows.slice(rows.length - FOLD_TAIL)];
  }, [expanded, rows, shouldFold]);

  const copyText = useMemo(() => rows.map(formatRow).join('\n'), [rows]);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(copyText).catch(() => {});
  }, [copyText]);

  return (
    <div className={styles.root} data-testid="file-diff-block">
      <div className={styles.toolbar}>
        <Button size="small" type="text" onClick={handleCopy}>
          复制
        </Button>
      </div>
      <div className={styles.body}>
        {!shouldFold || expanded ? (
          visibleRows.map((row, index) => (
            <span key={index} className={`${styles.line} ${rowClass(row.marker) ?? ''}`}>
              {formatRow(row)}
            </span>
          ))
        ) : (
          <>
            {rows.slice(0, FOLD_HEAD).map((row, index) => (
              <span key={`head-${index}`} className={`${styles.line} ${rowClass(row.marker) ?? ''}`}>
                {formatRow(row)}
              </span>
            ))}
            <Flexbox horizontal align="center" className={styles.fold}>
              <Button size="small" type="text" onClick={() => setExpanded(true)}>
                {`展开中间 ${hiddenCount} 行`}
              </Button>
            </Flexbox>
            {rows.slice(rows.length - FOLD_TAIL).map((row, index) => (
              <span key={`tail-${index}`} className={`${styles.line} ${rowClass(row.marker) ?? ''}`}>
                {formatRow(row)}
              </span>
            ))}
          </>
        )}
      </div>
      <div className={styles.footer}>{`+${added} -${deleted} · 1 个文件`}</div>
    </div>
  );
});
