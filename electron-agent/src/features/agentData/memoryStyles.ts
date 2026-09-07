import { createStaticStyles, cssVar } from 'antd-style';

export const memoryStyles = createStaticStyles(({ css }) => ({
  root: css`
    min-width: 0; container: memory / inline-size;
    font-size: 13px; line-height: 1.5;
    select { min-width: 0; max-width: 100%; }
    button, input, select, textarea, summary { &:focus-visible { outline: 2px solid ${cssVar.colorPrimary}; outline-offset: 2px; } }
  `,
  layout: css`
    display: grid; grid-template-columns: minmax(230px, 0.85fr) minmax(0, 1.4fr); gap: 16px; align-items: start; min-width: 0;
    > * { min-width: 0; }
    @container memory (max-width: 800px) {
      grid-template-columns: minmax(0, 1fr);
      &[data-detail-open='true'] > [data-memory-list-pane] { display: none; }
      &[data-detail-open='false'] > [data-memory-detail-pane] { display: none; }
    }
  `,
  tabs: css`display: flex; gap: 8px; margin-block-end: 14px;`,
  button: css`
    display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 34px; padding: 6px 11px;
    border: 1px solid ${cssVar.colorBorderSecondary}; border-radius: 6px; background: ${cssVar.colorBgContainer}; color: ${cssVar.colorText};
    font: inherit; font-size: 13px; cursor: pointer;
    &:hover { border-color: ${cssVar.colorPrimary}; } &:disabled { cursor: not-allowed; opacity: 0.55; }
    &[aria-selected='true'] { color: ${cssVar.colorPrimary}; background: ${cssVar.colorPrimaryBg}; border-color: ${cssVar.colorPrimaryBorder}; }
  `,
  primary: css`background: ${cssVar.colorPrimary}; color: ${cssVar.colorBgContainer}; border-color: ${cssVar.colorPrimary};`,
  danger: css`color: ${cssVar.colorError};`,
  list: css`display: flex; flex-direction: column; gap: 7px; min-width: 0;`,
  row: css`
    display: flex; flex-direction: column; gap: 8px; width: 100%; min-width: 0; text-align: start; padding: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary}; border-radius: 7px; background: ${cssVar.colorBgContainer}; color: ${cssVar.colorText}; cursor: pointer;
    &:hover { border-color: ${cssVar.colorPrimaryBorder}; }
    &[aria-pressed='true'] { border-color: ${cssVar.colorPrimary}; background: ${cssVar.colorPrimaryBg}; }
  `,
  summary: css`display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; line-height: 1.6; font-size: 13px;`,
  meta: css`display: flex; flex-wrap: wrap; gap: 6px 12px; color: ${cssVar.colorTextTertiary}; font-size: 11px; overflow-wrap: anywhere;`,
  detail: css`padding: 18px; border: 1px solid ${cssVar.colorBorderSecondary}; border-radius: 8px; min-width: 0; background: ${cssVar.colorBgContainer}; overflow-wrap: anywhere;`,
  toolbar: css`display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-block-end: 14px;`,
  heading: css`margin: 0 0 12px; font-size: 15px; font-weight: 600;`,
  document: css`
    color: ${cssVar.colorText}; line-height: 1.65; font-size: 13px; overflow-wrap: anywhere; min-width: 0;
    pre { max-height: 420px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; font: inherit; margin-block: 10px; padding: 12px; border: 1px solid ${cssVar.colorBorderSecondary}; border-radius: 6px; background: ${cssVar.colorFillQuaternary}; }
    dl { margin-block: 10px; } dt { color: ${cssVar.colorTextSecondary}; font-weight: 600; } dd { margin-inline-start: 16px; }
    ol { padding-inline-start: 22px; } details { margin-block-start: 20px; color: ${cssVar.colorTextSecondary}; }
    summary { cursor: pointer; }
  `,
  field: css`display: flex; flex-direction: column; gap: 7px; min-width: 0; margin-block: 15px; color: ${cssVar.colorTextSecondary}; font-size: 12px;`,
  control: css`
    box-sizing: border-box; width: 100%; min-width: 0; padding: 8px 10px; border: 1px solid ${cssVar.colorBorderSecondary}; border-radius: 6px;
    background: ${cssVar.colorBgContainer}; color: ${cssVar.colorText}; font: inherit; line-height: 1.6;
    &:disabled, &[readonly] { background: ${cssVar.colorFillQuaternary}; } &[rows] { resize: vertical; min-height: 180px; }
  `,
  notice: css`padding: 8px 10px; margin-block: 10px; border-radius: 5px; background: ${cssVar.colorInfoBg}; color: ${cssVar.colorTextSecondary}; font-size: 12px; overflow-wrap: anywhere;`,
  divider: css`border: 0; border-block-start: 1px solid ${cssVar.colorBorderSecondary}; margin-block: 18px;`,
}));
