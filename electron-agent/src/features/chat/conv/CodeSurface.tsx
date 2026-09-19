import { createStaticStyles, cssVar, cx } from 'antd-style';
import { memo, type ReactNode } from 'react';

const styles = createStaticStyles(({ css }) => ({
  box: css`
    overflow: auto;
    min-width: 0;
    max-width: 100%;
    max-height: min(50vh, 360px);
    padding: 9px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillQuaternary};
    font-family: ${cssVar.fontFamilyCode};
    font-size: 13px;
    line-height: 1.7;
    color: ${cssVar.colorText};
    white-space: pre-wrap;
    word-break: break-word;
  `,
  terminal: css`
    white-space: pre;
    word-break: normal;
    overflow-wrap: normal;
  `,
  error: css`
    color: ${cssVar.colorError};
  `,
}));

/**
 * 展开体里的代码/输出/diff 块：淡底 + hairline + 等宽 + 限高滚动。
 * `terminal`：按命令行排版，长行横向滚动，不折行叠层。
 */
export const CodeSurface = memo(function CodeSurface({
  children,
  isError,
  terminal,
}: {
  children: ReactNode;
  isError?: boolean;
  terminal?: boolean;
}) {
  return (
    <div
      className={cx(styles.box, terminal && styles.terminal, isError && styles.error)}
      data-testid="code-surface"
      data-variant={terminal ? 'terminal' : undefined}
    >
      {children}
    </div>
  );
});
