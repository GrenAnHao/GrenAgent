import { createStaticStyles, cssVar, cx } from 'antd-style';
import { memo, type ReactNode } from 'react';

const styles = createStaticStyles(({ css }) => ({
  box: css`
    overflow: auto;
    max-height: min(50vh, 360px);
    padding: 9px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillQuaternary};
    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    line-height: 1.65;
    color: ${cssVar.colorTextSecondary};
    white-space: pre-wrap;
    word-break: break-word;
  `,
  error: css`
    color: ${cssVar.colorError};
  `,
}));

/**
 * 展开体里的代码/输出/diff 块：淡底 + hairline + 等宽 + 限高滚动。
 * 不带 terminal 头栏、不重复命令（命令由上方行的 args 展示）。
 */
export const CodeSurface = memo(function CodeSurface({
  children,
  isError,
}: {
  children: ReactNode;
  isError?: boolean;
}) {
  return <div className={cx(styles.box, isError && styles.error)}>{children}</div>;
});
