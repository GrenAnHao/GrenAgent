import { Button } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback, useMemo } from 'react';

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
  lineNo: css`
    display: inline-block;
    min-width: 2ch;
    margin-inline-end: 8px;
    color: ${cssVar.colorTextSecondary};
    user-select: none;
  `,
}));

export const FileReadBlock = memo(function FileReadBlock({
  path: _path,
  text,
}: {
  path: string;
  text: string;
}) {
  const lines = useMemo(() => (text === '' ? [] : text.split(/\r?\n/)), [text]);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(text).catch(() => {});
  }, [text]);

  if (lines.length === 0) return null;

  return (
    <div className={styles.root} data-testid="file-read-block">
      <div className={styles.toolbar}>
        <Button size="small" type="text" onClick={handleCopy}>
          复制
        </Button>
      </div>
      <div className={styles.body}>
        {lines.map((line, index) => (
          <span key={index} className={styles.line}>
            <span className={styles.lineNo}>{index + 1}</span>
            {line}
          </span>
        ))}
      </div>
    </div>
  );
});
