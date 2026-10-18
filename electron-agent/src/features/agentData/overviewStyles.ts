import { createStaticStyles, cssVar } from 'antd-style';

export const overviewStyles = createStaticStyles(({ css }) => ({
  kpis: css`
    display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1px; margin-block-end: 16px;
    overflow: hidden; border: 1px solid ${cssVar.colorBorderSecondary}; border-radius: 10px; background: ${cssVar.colorBorderSecondary};
  `,
  kpi: css`
    display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 14px 16px; border: 0; text-align: start; cursor: pointer;
    background: ${cssVar.colorBgContainer}; color: ${cssVar.colorText}; font: inherit;
    &:hover { background: ${cssVar.colorFillQuaternary}; }
    &:focus-visible { outline: 2px solid ${cssVar.colorPrimary}; outline-offset: -2px; }
  `,
  kpiValue: css`font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums;`,
  kpiLabel: css`color: ${cssVar.colorTextTertiary}; font-size: 12px;`,
  kpiMeta: css`color: ${cssVar.colorTextTertiary}; font-size: 12px; margin-block-start: 4px;`,
  danger: css`color: ${cssVar.colorError};`,
  // 同一行的卡片拉到一样高、底边对齐；空状态在剩下的高度里居中。
  columns: css`display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; align-items: stretch;`,
  list: css`display: flex; flex-direction: column; min-width: 0; overflow: hidden; border: 1px solid ${cssVar.colorBorderSecondary}; border-radius: 10px; background: ${cssVar.colorBgContainer};`,
  listEmpty: css`flex: 1; display: flex; flex-direction: column; justify-content: center; margin: 16px 0;`,
  listHeader: css`display: flex; align-items: center; justify-content: space-between; padding: 8px 14px; font-weight: 500; border-block-end: 1px solid ${cssVar.colorBorderSecondary};`,
  row: css`
    display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 14px; border: 0; text-align: start; cursor: pointer;
    background: none; color: ${cssVar.colorText}; font: inherit;
    & + & { border-block-start: 1px solid ${cssVar.colorFillQuaternary}; }
    &:hover { background: ${cssVar.colorFillQuaternary}; }
    &:focus-visible { outline: 2px solid ${cssVar.colorPrimary}; outline-offset: -2px; }
    small { display: block; margin-block-start: 2px; color: ${cssVar.colorTextTertiary}; font-size: 11px; }
  `,
  rowMain: css`flex: 1; min-width: 0; overflow-wrap: anywhere;`,
  clamp: css`display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;`,
}));
