import { createStaticStyles, cssVar } from 'antd-style';

export const operationsStyles = createStaticStyles(({ css }) => ({
  root: css`
    min-width: 0;
    button:focus-visible, summary:focus-visible, select:focus-visible, input:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary}; outline-offset: 2px;
    }
    button:disabled { cursor: not-allowed; }
  `,
  auditRoot: css`display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden;`,
  scrollPanel: css`flex: 1; min-height: 0; min-width: 0; overflow: auto;`,
  table: css`
    table-layout: fixed;
    th, td { overflow-wrap: anywhere; word-break: normal; vertical-align: top; }
    th:first-child { width: 28%; }
    th:nth-child(2) { width: 24%; }
    th:nth-child(3) { width: 14%; }
    th:last-child { width: 190px; }
    @media (max-width: 800px) {
      table-layout: auto;
      th:last-child { width: auto; }
      th, td { padding-inline: 5px; }
    }
  `,
  actions: css`display: flex; flex-wrap: wrap; gap: 5px;`,
  /** 审计表（4 列）专用列宽，避免套用任务表（5 列）的比例把「详情」列撑得过宽。 */
  auditTable: css`
    th:first-child { width: 34%; }
    th:nth-child(2) { width: 30%; }
    th:nth-child(3) { width: 168px; }
    th:last-child { width: 128px; }
    td { vertical-align: top; }
    @media (max-width: 800px) { th:nth-child(3), th:last-child { width: auto; } }
  `,
  /** 审计「详情」单元格：横向排布展开与复制，避免继承抽屉详情的纵向大间距。 */
  auditDetail: css`
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
    details { min-width: 0; }
    summary { cursor: pointer; color: ${cssVar.colorTextSecondary}; }
    pre { margin: 8px 0 0; padding: 10px; white-space: pre-wrap; overflow-wrap: anywhere; background: ${cssVar.colorFillQuaternary}; border-radius: 6px; font-size: 11px; }
  `,
  detail: css`
    display: flex; flex-direction: column; gap: 20px; min-width: 0; padding-block: 4px 24px; color: ${cssVar.colorText}; overflow-wrap: anywhere;
    h3, h4, p { margin: 0; }
    h3 { font-size: 18px; line-height: 1.35; font-weight: 650; }
    h4 { color: ${cssVar.colorText}; font-size: 13px; line-height: 1.4; font-weight: 600; }
    dl { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 8px 14px; margin: 0; font-size: 13px; line-height: 1.5; }
    dt { color: ${cssVar.colorTextSecondary}; } dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
    pre { margin: 8px 0; padding: 10px; white-space: pre-wrap; overflow-wrap: anywhere; background: ${cssVar.colorFillQuaternary}; border-radius: 6px; font-size: 11px; }
    button:focus-visible, summary:focus-visible { outline: 2px solid ${cssVar.colorPrimary}; outline-offset: 2px; }
  `,
  detailHeader: css`display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding-block-end: 16px; border-block-end: 1px solid ${cssVar.colorBorderSecondary};`,
  eyebrow: css`color: ${cssVar.colorTextTertiary}; font-size: 11px; line-height: 1.4; letter-spacing: .04em; text-transform: uppercase;`,
  detailSection: css`display: flex; flex-direction: column; gap: 10px; min-width: 0;`,
  detailDisclosure: css`padding: 10px 12px; border: 1px solid ${cssVar.colorBorderSecondary}; border-radius: 7px; background: ${cssVar.colorFillQuaternary}; summary { cursor: pointer; color: ${cssVar.colorTextSecondary}; font-size: 12px; font-weight: 600; }`,
  timeline: css`display: grid; gap: 12px; margin: 0; padding-inline-start: 24px; font-size: 13px; line-height: 1.5; li { padding-inline-start: 4px; } small { display: block; margin-block-start: 3px; color: ${cssVar.colorTextTertiary}; font-size: 11px; }`,
  confirm: css`
    margin-block: 16px; padding: 14px; border: 1px solid ${cssVar.colorWarningBorder};
    border-radius: 7px; background: ${cssVar.colorWarningBg}; color: ${cssVar.colorText}; font-size: 12px;
  `,
  stack: css`display: flex; flex-direction: column; gap: 12px;`,
  section: css`display: flex; flex-direction: column; gap: 12px; align-items: start; margin-block-start: 16px;`,
  subnav: css`display: flex; gap: 6px; margin-block-end: 16px;`,
  selectedTab: css`background: ${cssVar.colorPrimaryBg}; color: ${cssVar.colorText}; border-color: ${cssVar.colorPrimaryBorder};`,
  filters: css`
    display: flex; flex-wrap: wrap; align-items: end; gap: 10px 12px;
    padding: 14px 16px; margin-block-end: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary}; border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgContainer};
    label { display: flex; flex-direction: column; gap: 5px; color: ${cssVar.colorTextSecondary}; font-size: 12px; }
    input, select { min-width: 0; max-width: 100%; box-sizing: border-box; }
  `,
  filterActions: css`display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-inline-start: auto; align-self: end;`,
  diagnostic: css`
    padding: 14px 16px; border-block-end: 1px solid ${cssVar.colorFillQuaternary};
    font-size: 12px; overflow-wrap: anywhere;
    display: flex; flex-direction: column; gap: 8px;
    &:last-child { border-block-end: 0; }
    strong { font-size: 13px; font-weight: 600; }
  `,
  unchecked: css`background: ${cssVar.colorFillTertiary}; color: ${cssVar.colorTextSecondary};`,
  warning: css`background: ${cssVar.colorWarningBg}; color: ${cssVar.colorWarningText};`,
  okay: css`background: ${cssVar.colorSuccessBg}; color: ${cssVar.colorSuccessText};`,
}));
