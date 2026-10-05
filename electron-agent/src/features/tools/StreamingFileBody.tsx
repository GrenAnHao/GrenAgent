import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useEffect, useRef, useState } from 'react';
import { useAutoScroll } from '../../hooks/useAutoScroll';
import { CodeCard, codeCardContentClass } from './CodeCard';
import { languageFromPath } from './codeLanguage';
import { fileCardVerb, mutationPath } from './fileDiffModel';
import { LazySyntaxHighlighter } from './LazyHighlighter';
import {
  EDIT_LIVE_PAIRS,
  exceedsHighlightBudget,
  inferLanguage,
  lineCount,
  streamingEditPairs,
  streamingEditStats,
  streamingWritePreview,
  writeContent,
  type StreamingEditPair,
} from './streamingFileModel';

const styles = createStaticStyles(({ css }) => ({
  note: css`
    padding: 6px 12px 0;
    color: ${cssVar.colorTextDescription};
    font-size: 12px;
  `,
  scroller: css`
    flex: 1;
    min-height: 0;
    max-height: min(50vh, 360px);
    overflow: auto;

    pre {
      overflow: visible;
    }
  `,
  plain: css`
    margin: 0;
    padding: 16px;
    white-space: pre;
    font-family: var(--pi-font-mono);
    font-size: 13px;
  `,
  oldBlock: css`
    border-inline-start: 3px solid ${cssVar.colorError};
    background: ${cssVar.colorErrorBg};
  `,
  newBlock: css`
    border-inline-start: 3px solid ${cssVar.colorSuccess};
    background: ${cssVar.colorSuccessBg};
  `,
  gap: css`
    padding: 2px 12px;
    color: ${cssVar.colorTextDescription};
    font-size: 12px;
  `,
}));

function fileNameOf(path: string): string | undefined {
  if (!path) return undefined;
  return path.split(/[/\\]/).pop() || path;
}

/**
 * 高亮器在正文持续增长时初始化完不了，会一直停在 fallback。
 * 这里把最新正文直接交给它和 fallback，生成中先看到纯文本，高亮能跟上再替换。
 */
function HighlightedText({
  text,
  language,
}: {
  text: string;
  language: string;
}) {
  return (
    <LazySyntaxHighlighter
      animated
      className={codeCardContentClass}
      fallback={<pre className={styles.plain}>{text}</pre>}
      language={language}
      variant="borderless"
    >
      {text}
    </LazySyntaxHighlighter>
  );
}

function WriteBody({ args, language }: { args: unknown; language?: string }) {
  const content = writeContent(args);
  const degradedRef = useRef(false);
  if (!degradedRef.current && exceedsHighlightBudget(content)) degradedRef.current = true;

  if (!content) return <div className={styles.note}>等待参数…</div>;
  if (degradedRef.current) {
    const preview = streamingWritePreview(args);
    return (
      <>
        <div className={styles.note}>
          已接收 {preview.totalLines} 行
          {preview.omittedLines > 0 ? `（前 ${preview.omittedLines} 行已省略）` : ''}
        </div>
        <pre className={styles.plain}>{preview.text}</pre>
      </>
    );
  }
  if (!language) return <pre className={styles.plain}>{content}</pre>;
  return <HighlightedText language={language} text={content} />;
}

function EditBody({ args }: { args: unknown }) {
  const path = mutationPath(args);
  const language = path ? languageFromPath(path) : 'text';
  const pairs = streamingEditPairs(args);
  if (pairs.length === 0) return <div className={styles.note}>等待参数…</div>;
  const foldedCount = Math.max(0, pairs.length - EDIT_LIVE_PAIRS);
  const folded = pairs.slice(0, foldedCount);
  const live = pairs.slice(foldedCount);
  return (
    <>
      {folded.map((pair, index) => (
        <div key={`fold-${index}`} className={styles.note}>
          第 {index + 1} 处：-{lineCount(pair.oldText ?? '')} 行 / +{lineCount(pair.newText ?? '')} 行
        </div>
      ))}
      {live.map((pair, index) => (
        <EditPair key={`live-${foldedCount + index}`} language={language} pair={pair} separated={index > 0 || foldedCount > 0} />
      ))}
    </>
  );
}

function EditPair({
  pair,
  language,
  separated,
}: {
  pair: StreamingEditPair;
  language: string;
  separated: boolean;
}) {
  return (
    <>
      {separated ? <div className={styles.gap}>…</div> : null}
      {pair.oldText !== undefined ? (
        <div className={styles.oldBlock} data-kind="old">
          <HighlightedText language={language} text={pair.oldText} />
        </div>
      ) : null}
      {pair.newText !== undefined ? (
        <div className={styles.newBlock} data-kind="new">
          <HighlightedText language={language} text={pair.newText} />
        </div>
      ) : null}
    </>
  );
}

export const StreamingFileBody = memo(function StreamingFileBody({
  toolName,
  args,
}: {
  toolName: string;
  args: unknown;
}) {
  const writing = fileCardVerb(toolName) === '写入';
  const path = mutationPath(args);
  const content = writeContent(args);
  const fromPath = path ? languageFromPath(path) : undefined;
  const guessedRef = useRef<string | undefined>(undefined);
  if (!guessedRef.current) {
    const guessed = inferLanguage(content);
    if (guessed) guessedRef.current = guessed;
  }
  const language = fromPath && fromPath !== 'text' ? fromPath : guessedRef.current;
  const fileName = fileNameOf(path);
  const stats = writing
    ? { added: lineCount(content), deleted: 0 }
    : streamingEditStats(args);
  const contentRef = useRef<HTMLDivElement>(null);
  const [grow, setGrow] = useState(0);
  const revision = writing
    ? writeContent(args).length
    : streamingEditPairs(args).reduce((sum, pair) => sum + (pair.oldText?.length ?? 0) + (pair.newText?.length ?? 0), 0);
  const { ref, handleScroll } = useAutoScroll<HTMLDivElement>({ deps: [grow, revision] });

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setGrow((n) => n + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <CodeCard added={stats.added} contained deleted={stats.deleted} fileName={fileName} language={fileName ? undefined : language}>
      <div ref={ref} className={styles.scroller} data-testid="streaming-file-body" onScroll={handleScroll}>
        <div ref={contentRef}>{writing ? <WriteBody args={args} language={language} /> : <EditBody args={args} />}</div>
      </div>
    </CodeCard>
  );
});
