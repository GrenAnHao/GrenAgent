import { createStaticStyles, cssVar } from 'antd-style';

export const wikiStyles = createStaticStyles(({ css }) => ({
  root: css`
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
    padding: max(24px, calc((100% - 1180px) / 2));
    padding-block-start: 16px;
    font-size: 13px;
    line-height: 1.5;
    color: ${cssVar.colorText};
    background: ${cssVar.colorBgLayout};
    [hidden] { display: none !important; }
    button:focus-visible, input:focus-visible, select:focus-visible, [tabindex]:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary}; outline-offset: 3px;
    }
  `,
  header: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 18px 20px;
    margin-block-end: 16px;
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgContainer};
    border: 1px solid ${cssVar.colorBorderSecondary};
    & > div:first-child {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    h3 {
      margin: 0;
      font-size: 17px;
      font-weight: 600;
      line-height: 1.3;
    }
    p {
      margin: 0;
      font-size: 13px;
      color: ${cssVar.colorTextSecondary};
      overflow-wrap: anywhere;
    }
  `,
  headerTitle: css`
    display: flex;
    align-items: center;
    gap: 12px;
  `,
  headerMeta: css`
    display: flex;
    align-items: center;
    gap: 16px;
    margin-block-start: 8px;
    padding-block-start: 8px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
    font-variant-numeric: tabular-nums;
  `,
  toolbar: css`
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    flex: 0 0 auto;
  `,
  muted: css`color: ${cssVar.colorTextSecondary}; font-size: 12px; overflow-wrap: anywhere;`,
  listHeader: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    margin-block-end: 16px;
  `,
  listToolbar: css`
    display: flex;
    align-items: center;
    gap: 10px;
    margin-block-end: 16px;
  `,
  list: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 12px;
  `,
  libraryHeader: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-block-end: 8px;
  `,
  libraryMeta: css`
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
    margin-block-start: 10px;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
    & > span {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
  `,
  resourceList: css`
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: -4px;
    padding: 4px;
  `,
  /**
   * antd Button 充当两行列表项：只覆盖布局方向与高度，外观交给 antd；
   * 选中态用 aria-pressed 驱动，避免切换 Button type（会重挂载节点、丢失焦点恢复引用）。
   * antd 给 .ant-btn 写死了 white-space: nowrap 与 align-items: center，长标题必须显式放开换行并靠左。
   */
  resource: css`
    height: auto;
    min-width: 0;
    flex-direction: column;
    align-items: stretch;
    justify-content: flex-start;
    padding-block: 8px;
    border: 1px solid transparent;
    white-space: normal;
    text-align: start;
    overflow-wrap: anywhere;
    &[aria-pressed='true'] {
      background: ${cssVar.colorPrimaryBg};
      border-color: ${cssVar.colorPrimaryBorder};
    }
    small {
      display: block;
      margin-block-start: 4px;
      font-size: 11px;
      opacity: 0.75;
    }
  `,
  detail: css`
    min-width: 0;
    padding: 18px;
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgContainer};
    border: 1px solid ${cssVar.colorBorderSecondary};
  `,
  emptyState: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 400px;
    color: ${cssVar.colorTextTertiary};
    text-align: center;
    font-size: 13px;
  `,
  document: css`width: 100%; max-width: 760px; margin-inline: auto; line-height: 1.65; overflow-wrap: anywhere; pre { white-space: pre-wrap; overflow-wrap: anywhere; } img { max-width: 100%; }`,
  editor: css`display: flex; flex-direction: column; gap: 12px; min-width: 0;`,
  preview: css`padding: 16px; min-height: 100px; border: 1px solid ${cssVar.colorBorderSecondary}; border-radius: 6px; background: ${cssVar.colorBgContainer};`,
  field: css`display: flex; flex-direction: column; gap: 6px; margin-block: 12px;`,
  diagnostics: css`padding: 12px; margin-block: 12px; border: 1px solid ${cssVar.colorWarningBorder}; border-radius: 6px; overflow-wrap: anywhere; background: ${cssVar.colorWarningBg};`,
  crumb: css`padding-inline: 0; height: auto; font-size: inherit;`,
  back: css`padding-inline: 4px;`,
  templateGrid: css`display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px;`,
  templateCol: css`display: flex; flex-direction: column; gap: 8px; min-width: 0;`,
}));
