import { createStaticStyles, cssVar } from 'antd-style';
import FileIcon from '../../components/FileIcon';
import { memo } from 'react';
import { extractText } from './toolUtils';
import { parseCodeSearch, parseGlobOutput, parseGrepOutput } from '../../lib/searchResults';
import { languageFromPath } from './codeLanguage';
import { CodeCard } from './CodeCard';
import { LazyHighlighter } from './LazyHighlighter';

const styles = createStaticStyles(({ css }) => ({
  wrap: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    max-width: 100%;
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

/** grep 命中卡：按文件分组，命中内容用 Highlighter 高亮。 */
export const GrepCard = memo(function GrepCard({ result }: { result: unknown }) {
  const { truncated, files } = parseGrepOutput(extractText(result));
  if (files.length === 0) return <div className={styles.empty}>未找到匹配</div>;
  return (
    <div className={styles.wrap} data-testid="card-grep">
      {files.map((f) => {
        const { name } = splitPath(f.path);
        return (
          <CodeCard fileName={name} key={f.path}>
            <LazyHighlighter
              copyable={false}
              language={languageFromPath(f.path)}
              showLanguage={false}
              variant="borderless"
              style={{ width: '100%' }}
              styles={{ content: { fontFamily: 'var(--pi-font-mono)', fontSize: 13 } }}
            >
              {f.matches.map((m) => (m.line > 0 ? `${m.line}: ${m.text}` : m.text)).join('\n')}
            </LazyHighlighter>
          </CodeCard>
        );
      })}
      {truncated && <div className={styles.more}>结果较多，已截断显示</div>}
    </div>
  );
});

/** 本地代码检索卡：按文件分组展示 `search` 的命中行。 */
export const CodeSearchCard = memo(function CodeSearchCard({ result }: { result: unknown }) {
  const details =
    result && typeof result === 'object' && 'details' in result
      ? (result as { details?: unknown }).details
      : undefined;
  const view = parseCodeSearch(
    extractText(result),
    details && typeof details === 'object' && !Array.isArray(details) ? (details as Record<string, unknown>) : undefined,
  );
  if (view.error) return <div className={styles.empty}>{view.error}</div>;
  if (view.files.length === 0) return <div className={styles.empty}>未找到匹配</div>;
  return (
    <div className={styles.wrap} data-testid="card-code-search">
      {view.files.map((f) => {
        const { name } = splitPath(f.path);
        return (
          <CodeCard fileName={name} key={f.path}>
            <LazyHighlighter
              copyable={false}
              language={languageFromPath(f.path)}
              showLanguage={false}
              variant="borderless"
              style={{ width: '100%' }}
              styles={{ content: { fontFamily: 'var(--pi-font-mono)', fontSize: 13 } }}
            >
              {f.matches.map((m) => (m.line > 0 ? `${m.line}: ${m.text}` : m.text)).join('\n')}
            </LazyHighlighter>
          </CodeCard>
        );
      })}
      {view.capped && <div className={styles.more}>结果较多，已截断显示</div>}
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
