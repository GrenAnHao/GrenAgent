import { createStaticStyles, cssVar, cx } from 'antd-style';

/**
 * Mermaid 外框与加载占位。Mermaid 组件本身按需加载（带 beautiful-mermaid / elkjs，体积大），
 * 分块到达前 LazyMarkdown 先画这个占位，和组件内部预检时的占位同一份样式，高度不跳。
 */
export const mermaidBoxStyles = createStaticStyles(({ css }) => ({
  root: css`
    width: 100%;
    min-width: 0;
    margin: 8px 0;
  `,
  loading: css`
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 180px;
    color: ${cssVar.colorTextTertiary};
    font-size: 13px;
  `,
}));

export function MermaidLoading() {
  return <div className={cx(mermaidBoxStyles.root, mermaidBoxStyles.loading)}>Loading diagram…</div>;
}
