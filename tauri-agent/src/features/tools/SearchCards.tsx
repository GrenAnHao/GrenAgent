import { createStaticStyles, cssVar } from 'antd-style';
import FileIcon from '../../components/FileIcon';
import { memo } from 'react';
import { extractText } from './toolUtils';
import { parseCodeSearchHits, parseGlobOutput, parseGrepOutput } from '../../lib/searchResults';

const styles = createStaticStyles(({ css }) => ({
  wrap: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    max-width: 560px;
  `,
  file: css`
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
    background: ${cssVar.colorBgContainer};
  `,
  fileHead: css`
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  fileName: css`
    overflow: hidden;
    flex-shrink: 0;
    max-width: 240px;
    color: ${cssVar.colorText};
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  dir: css`
    overflow: hidden;
    flex: 1;
    min-width: 0;
    color: ${cssVar.colorTextQuaternary};
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  `,
  count: css`
    flex-shrink: 0;
    margin-inline-start: auto;
    padding: 0 6px;
    border-radius: 999px;
    background: ${cssVar.colorFillTertiary};
    color: ${cssVar.colorTextTertiary};
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  `,
  matches: css`
    display: flex;
    flex-direction: column;
    border-block-start: 1px solid ${cssVar.colorFillQuaternary};
  `,
  matchRow: css`
    display: flex;
    gap: 8px;
    padding: 2px 8px;
    font-family: var(--code-font, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 12px;
    line-height: 1.5;

    &:hover {
      background: ${cssVar.colorFillQuaternary};
    }
  `,
  lineNo: css`
    flex-shrink: 0;
    min-width: 36px;
    color: ${cssVar.colorTextQuaternary};
    text-align: right;
    user-select: none;
    font-variant-numeric: tabular-nums;
  `,
  code: css`
    overflow: hidden;
    color: ${cssVar.colorTextSecondary};
    text-overflow: ellipsis;
    white-space: pre;
  `,
  row: css`
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 7px;
    background: ${cssVar.colorBgContainer};
    font-size: 12px;
  `,
  empty: css`
    padding: 4px 2px;
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
  `,
  more: css`
    padding: 2px;
    color: ${cssVar.colorTextQuaternary};
    font-size: 11px;
  `,
}));

function splitPath(p: string): { dir: string; name: string } {
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const i = norm.lastIndexOf('/');
  return i >= 0 ? { dir: norm.slice(0, i), name: norm.slice(i + 1) } : { dir: '', name: norm };
}

/** grep 命中卡：按文件分组，每组列出命中行号 + 内容（对齐 Cursor 的 Grepped 结果）。 */
export const GrepCard = memo(function GrepCard({ result }: { result: unknown }) {
  const { truncated, files } = parseGrepOutput(extractText(result));
  if (files.length === 0) return <div className={styles.empty}>未找到匹配</div>;
  return (
    <div className={styles.wrap} data-testid="card-grep">
      {files.map((f) => {
        const { dir, name } = splitPath(f.path);
        return (
          <div key={f.path} className={styles.file}>
            <div className={styles.fileHead} title={f.path}>
              <FileIcon fileName={name} size={13} variant="raw" />
              <span className={styles.fileName}>{name}</span>
              {dir && <span className={styles.dir}>{dir}</span>}
              <span className={styles.count}>{f.matches.length}</span>
            </div>
            <div className={styles.matches}>
              {f.matches.map((m, i) => (
                <div className={styles.matchRow} key={i}>
                  <span className={styles.lineNo}>{m.line}</span>
                  <span className={styles.code}>{m.text}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {truncated && <div className={styles.more}>结果较多，已截断显示</div>}
    </div>
  );
});

/** glob 找文件卡：逐个文件行（文件名 + 目录）。 */
export const GlobCard = memo(function GlobCard({ result }: { result: unknown }) {
  const { files, truncated } = parseGlobOutput(extractText(result));
  if (files.length === 0) return <div className={styles.empty}>未找到文件</div>;
  return (
    <div className={styles.wrap} data-testid="card-glob">
      {files.map((p) => {
        const { dir, name } = splitPath(p);
        return (
          <div className={styles.row} key={p} title={p}>
            <FileIcon fileName={name} size={13} variant="raw" />
            <span className={styles.fileName}>{name}</span>
            {dir && <span className={styles.dir}>{dir}</span>}
          </div>
        );
      })}
      {truncated && <div className={styles.more}>结果较多，已截断显示</div>}
    </div>
  );
});

/** code_search 语义检索卡：命中代码块 file:行范围 + 相关度分数。 */
export const CodeSearchCard = memo(function CodeSearchCard({ result }: { result: unknown }) {
  const hits = parseCodeSearchHits(result);
  if (hits.length === 0) {
    return <div className={styles.empty}>{extractText(result).trim() || '未找到结果'}</div>;
  }
  return (
    <div className={styles.wrap} data-testid="card-code_search">
      {hits.map((h, i) => {
        const { dir, name } = splitPath(h.file);
        const range =
          h.startLine != null
            ? `:${h.startLine}${h.endLine != null && h.endLine !== h.startLine ? `-${h.endLine}` : ''}`
            : '';
        return (
          <div className={styles.row} key={i} title={h.file}>
            <FileIcon fileName={name} size={13} variant="raw" />
            <span className={styles.fileName}>
              {name}
              {range}
            </span>
            {dir && <span className={styles.dir}>{dir}</span>}
            {h.score != null && <span className={styles.count}>{h.score.toFixed(2)}</span>}
          </div>
        );
      })}
    </div>
  );
});
