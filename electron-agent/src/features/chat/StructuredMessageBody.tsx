import { createStaticStyles, cssVar } from 'antd-style';
import { memo, type ReactNode } from 'react';
import type { StructuredMessageText } from './structuredMessageText';

const styles = createStaticStyles(({ css }) => ({
  pre: css`
    margin: 0;
    max-width: 100%;
    overflow: auto;
    font-family: ${cssVar.fontFamilyCode};
    font-size: 12.5px;
    line-height: 1.65;
    white-space: pre-wrap;
    word-break: break-word;
  `,
}));

export const StructuredMessageBody = memo(function StructuredMessageBody({
  formatted,
  fallback,
}: {
  formatted: StructuredMessageText;
  fallback: ReactNode;
}) {
  if (formatted.mode !== 'pre') return fallback;
  return (
    <pre className={styles.pre} data-testid="structured-pre">
      {formatted.text}
    </pre>
  );
});
