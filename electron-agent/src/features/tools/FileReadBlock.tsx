import { memo } from 'react';
import { languageFromPath } from './codeLanguage';
import { LazyHighlighter } from './LazyHighlighter';
import { CodeCard } from './CodeCard';

const codeStyle = { fontFamily: 'var(--pi-font-mono)', fontSize: 13 } as const;

export const FileReadBlock = memo(function FileReadBlock({
  path,
  text,
}: {
  path: string;
  text: string;
}) {
  if (!text) return null;
  const fileName = path.split(/[/\\]/).pop() || path;
  return (
    <div data-testid="file-read-block" style={{ width: '100%', minWidth: 0 }}>
      <CodeCard fileName={fileName}>
        <LazyHighlighter
          copyable={false}
          language={languageFromPath(path)}
          showLanguage={false}
          variant="borderless"
          style={{ width: '100%' }}
          styles={{ content: codeStyle }}
        >
          {text}
        </LazyHighlighter>
      </CodeCard>
    </div>
  );
});
