import { createStaticStyles, cssVar } from 'antd-style';

export const memoryStyles = createStaticStyles(({ css }) => ({
  root: css`
    min-width: 0; container: memory / inline-size;
    font-size: 13px; line-height: 1.5;
    summary:focus-visible { outline: 2px solid ${cssVar.colorPrimary}; outline-offset: 2px; }
  `,
  groups: css`margin-block-end: 12px;`,
  count: css`margin-inline-start: 6px; color: ${cssVar.colorTextQuaternary}; font-size: 12px; .ant-radio-button-wrapper-checked & { color: inherit; opacity: .75; }`,
  gap: css`margin-inline-start: 12px; border-radius: 6px !important;`,
  backButton: css`@container workbench-split (min-width: 800px) { display: none; }`,
  /** 列表尾部的分页按钮：与上方平铺行同一条分隔线。 */
  loadMore: css`padding: 8px 16px; border-block-start: 1px solid ${cssVar.colorFillQuaternary};`,
  meta: css`display: flex; flex-wrap: wrap; gap: 6px 12px; margin-block-end: 14px; color: ${cssVar.colorTextTertiary}; font-size: 12px; overflow-wrap: anywhere;`,
  toolbar: css`display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-block-end: 14px;`,
  document: css`
    color: ${cssVar.colorText}; line-height: 1.65; font-size: 13px; overflow-wrap: anywhere; min-width: 0;
    pre { max-height: 420px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; font: inherit; margin-block: 10px; padding: 12px; border: 1px solid ${cssVar.colorBorderSecondary}; border-radius: 6px; background: ${cssVar.colorFillQuaternary}; }
    details { margin-block-start: 20px; color: ${cssVar.colorTextSecondary}; }
    summary { cursor: pointer; }
  `,
  field: css`display: flex; flex-direction: column; gap: 7px; min-width: 0; margin-block: 15px; color: ${cssVar.colorTextSecondary}; font-size: 12px;`,
}));
