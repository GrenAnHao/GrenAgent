import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { CodeSurface } from '../chat/conv/CodeSurface';
import { useAutoScroll } from '../../hooks/useAutoScroll';
import { fileCardVerb } from './fileDiffModel';
import { clipEditPairs, streamingEditPairs, streamingWritePreview } from './streamingFileModel';

const styles = createStaticStyles(({ css }) => ({
  note: css`
    margin-bottom: 6px;
    color: ${cssVar.colorTextDescription};
    font-size: 12px;
  `,
  oldText: css`
    margin: 0;
    color: ${cssVar.colorError};
    white-space: pre;
  `,
  newText: css`
    margin: 0;
    color: ${cssVar.colorSuccess};
    white-space: pre;
  `,
  gap: css`
    color: ${cssVar.colorTextDescription};
  `,
}));

function prefixed(text: string, mark: string): string {
  return text.split('\n').map((line) => `${mark}${line}`).join('\n');
}

export const StreamingFileBody = memo(function StreamingFileBody({
  toolName,
  args,
}: {
  toolName: string;
  args: unknown;
}) {
  const writing = fileCardVerb(toolName) === '写入';
  const preview = writing ? streamingWritePreview(args) : null;
  const clipped = writing ? null : clipEditPairs(streamingEditPairs(args));
  const revision = preview
    ? preview.revision
    : (clipped?.pairs ?? []).reduce((sum, pair) => sum + (pair.oldText?.length ?? 0) + (pair.newText?.length ?? 0), 0);
  const { ref, handleScroll } = useAutoScroll<HTMLDivElement>({ deps: [revision] });
  const empty = writing ? !preview?.text : (clipped?.pairs.length ?? 0) === 0;

  return (
    <CodeSurface ref={ref} onScroll={handleScroll} terminal testId="streaming-file-body">
      {writing && preview ? (
        <div className={styles.note}>
          已接收 {preview.totalLines} 行
          {preview.omittedLines > 0 ? `（前 ${preview.omittedLines} 行已省略）` : ''}
        </div>
      ) : null}
      {!writing && clipped && clipped.omitted > 0 ? (
        <div className={styles.note}>已省略前 {clipped.omitted} 处</div>
      ) : null}
      {empty ? <div className={styles.note}>等待参数…</div> : null}
      {writing && preview?.text ? preview.text : null}
      {!writing && clipped?.pairs.map((pair, index) => (
        <div key={index}>
          {index > 0 ? <div className={styles.gap}>…</div> : null}
          {pair.oldText !== undefined ? <pre className={styles.oldText}>{prefixed(pair.oldText, '-')}</pre> : null}
          {pair.newText !== undefined ? <pre className={styles.newText}>{prefixed(pair.newText, '+')}</pre> : null}
        </div>
      ))}
    </CodeSurface>
  );
});
