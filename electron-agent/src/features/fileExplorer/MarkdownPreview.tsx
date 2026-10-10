import { useEffect, useState } from 'react';
import { LazyMarkdown } from '../chat/LazyMarkdown';
import { fileExplorerStyles as styles } from './fileExplorerStyles';

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    if (delayMs <= 0) {
      setShown(value);
      return undefined;
    }
    const timer = setTimeout(() => setShown(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return delayMs <= 0 ? value : shown;
}

export interface MarkdownPreviewProps {
  content: string;
  /** 边写边看时防抖，避免每个按键都重新解析整篇。 */
  debounceMs: number;
}

/** Markdown 预览：和对话正文同一套渲染（含 mermaid）。 */
export function MarkdownPreview({ content, debounceMs }: MarkdownPreviewProps) {
  const shown = useDebouncedValue(content, debounceMs);
  return (
    <div className={styles.markdown} tabIndex={0} data-testid="file-markdown-preview">
      <LazyMarkdown variant="chat">{shown}</LazyMarkdown>
    </div>
  );
}
